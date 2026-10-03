import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approval } from "@hearth/db";
import { type Caller, integrationCaller, jarvisCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GOOGLE_SERVICE, SCOPES } from "../google/client.ts";
import { FakeGoogle } from "../google/fake.ts";
import { ALL_MODULES } from "../index.ts";
import { BLOB_SERVICE, BlobStore } from "./blobs.ts";
import { parseInvite } from "./invites.ts";
import type { ThreadSummary, ThreadView } from "./views.ts";

const ME = "owner@example.com";
const BOSS = "boss@work.example";

const ics = (o: { uid: string; organizer?: string; method?: string; summary?: string }) =>
  [
    "BEGIN:VCALENDAR",
    `METHOD:${o.method ?? "REQUEST"}`,
    "BEGIN:VEVENT",
    `UID:${o.uid}`,
    `SUMMARY:${o.summary ?? "Planning"}`,
    "DTSTART:20261005T150000Z",
    "DTEND:20261005T160000Z",
    ...(o.organizer ? [`ORGANIZER;CN=Boss:mailto:${o.organizer}`] : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

const invitation = (from: string, body: string) =>
  Buffer.from(
    [
      `From: ${from}`,
      `To: ${ME}`,
      "Subject: Invitation: Planning",
      "Date: Thu, 01 Oct 2026 12:00:00 +0000",
      `Message-ID: <${Math.random().toString(36).slice(2)}@work.example>`,
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="b"',
      "",
      "--b",
      "Content-Type: text/plain",
      "",
      "You're invited.",
      "--b",
      "Content-Type: text/calendar; charset=UTF-8; method=REQUEST",
      "",
      body,
      "--b--",
      "",
    ].join("\r\n"),
  );

let t: TestKernel;
let g: FakeGoogle;
let dir: string;

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  g = new FakeGoogle(ME);
  g.grants = ["openid", "email", ...SCOPES.calendar, ...SCOPES.gmail];
  t.kernel.services[GOOGLE_SERVICE] = g.client();
  dir = await mkdtemp(join(tmpdir(), "hearth-blobs-"));
  t.kernel.services[BLOB_SERVICE] = new BlobStore(dir);
  const client = g.client();
  const url = new URL(await client.startSignIn(t.tdb.db, [...SCOPES.calendar, ...SCOPES.gmail]));
  await client.finishSignIn(t.tdb.db, url.searchParams.get("state")!, "the-code");
});
afterEach(async () => {
  await t.destroy();
  await rm(dir, { recursive: true, force: true });
});

async function ok<T>(name: string, input: unknown = {}, caller: Caller = ownerCaller()) {
  const res = await t.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}

async function deliver(raw: Buffer) {
  const id = g.gmail.deliver({ from: { address: BOSS }, subject: "x", text: "x" });
  g.gmail.messages.get(id)!.raw = raw;
  await ok("calendar.sync", {}, integrationCaller("google"));
  await ok("mail.sync", {}, integrationCaller("google"));
  const [x] = await ok<ThreadSummary[]>("mail.threads", { view: "all" });
  return ok<ThreadView>("mail.thread", { id: x!.id });
}

describe("calendar invitations in mail", () => {
  it("reads an invitation, folded lines and time zones included", () => {
    const parsed = parseInvite(
      [
        "BEGIN:VCALENDAR",
        "METHOD:REQUEST",
        "BEGIN:VEVENT",
        "UID:abc@x.example",
        "SUMMARY:Quarterly planning\\, part",
        " one",
        "DTSTART;TZID=America/New_York:20261005T110000",
        "ORGANIZER:MAILTO:Boss@Work.example",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n"),
    );
    expect(parsed).toEqual({
      uid: "abc@x.example",
      method: "REQUEST",
      summary: "Quarterly planning, partone",
      start: "2026-10-05T15:00:00.000Z",
      organizer: "boss@work.example",
    });
    expect(parseInvite(ics({ uid: "a", method: "PUBLISH" }))).toBeNull();
  });

  it("shows the invitation as the event on your calendar, and answers it", async () => {
    const ev = g.put(ME, {
      summary: "Planning (calendar's name)",
      start: { dateTime: "2026-10-05T15:00:00Z" },
      end: { dateTime: "2026-10-05T16:00:00Z" },
      organizer: { email: BOSS },
      attendees: [
        { email: BOSS, organizer: true },
        { email: ME, self: true, responseStatus: "needsAction" },
      ],
    });
    const view = await deliver(
      invitation(BOSS, ics({ uid: `${ev.id}@google.com`, organizer: BOSS })),
    );
    const [m] = view.messages;
    expect(m!.invite).toMatchObject({
      method: "REQUEST",
      event: { title: "Planning (calendar's name)", response: "needsAction" },
    });
    // You answer it on the calendar, so it isn't mail waiting on your reply.
    expect(view.waiting).toBeNull();
    await ok("calendar.respond", { id: m!.invite!.event!.id, response: "accepted" });
    const again = await ok<ThreadView>("mail.thread", { id: view.id });
    expect(again.messages[0]!.invite!.event!.response).toBe("accepted");
  });

  it("won't match an invitation to an event someone else organizes", async () => {
    const ev = g.put(ME, {
      summary: "Board meeting",
      start: { dateTime: "2026-10-05T15:00:00Z" },
      end: { dateTime: "2026-10-05T16:00:00Z" },
      organizer: { email: BOSS },
      attendees: [{ email: ME, self: true }],
    });
    const forged = invitation(
      "mallory@evil.example",
      ics({ uid: `${ev.id}@google.com`, organizer: "mallory@evil.example" }),
    );
    const view = await deliver(forged);
    expect(view.messages[0]!.invite).toMatchObject({ event: null });
    // Naming the real organizer from another address isn't an invitation at all.
    const posing = invitation(
      "mallory@evil.example",
      ics({ uid: `${ev.id}@google.com`, organizer: BOSS }),
    );
    const id = g.gmail.deliver({ from: { address: BOSS }, subject: "x", text: "x" });
    g.gmail.messages.get(id)!.raw = posing;
    await ok("mail.sync", {}, integrationCaller("google"));
    const all = await ok<ThreadSummary[]>("mail.threads", { view: "all" });
    const views = await Promise.all(all.map((x) => ok<ThreadView>("mail.thread", { id: x.id })));
    expect(views.flatMap((v) => v.messages.map((m) => m.invite?.event ?? null))).toEqual([
      null,
      null,
    ]);
  });

  it("asks before Jarvis answers, naming the meeting, and won't answer one that changed", async () => {
    const ev = g.put(ME, {
      summary: "Planning",
      start: { dateTime: "2026-10-05T15:00:00Z" },
      end: { dateTime: "2026-10-05T16:00:00Z" },
      organizer: { email: BOSS },
      attendees: [{ email: ME, self: true }],
    });
    const view = await deliver(
      invitation(BOSS, ics({ uid: `${ev.id}@google.com`, organizer: BOSS })),
    );
    const eventId = view.messages[0]!.invite!.event!.id;
    const respond = t.kernel.registry.action("calendar.respond")!;
    const snap = await respond.snapshot!({ id: eventId }, { db: t.tdb.db, now: t.clock.now() });
    const jarvis = jarvisCaller("untrusted");
    const asked = await t.kernel.execute(
      "calendar.respond",
      { id: eventId, response: "accepted", ...snap },
      jarvis,
    );
    expect(asked).toMatchObject({ status: "pending_approval" });
    const [row] = await t.tdb.db.select().from(approval);
    expect(row!.summary).toMatch(/^Answer the invitation to "Planning", .+: accepted$/);
    g.put(ME, { ...ev, summary: "Planning (moved)", start: { dateTime: "2026-10-06T15:00:00Z" } });
    await ok("calendar.sync", {}, integrationCaller("google"));
    expect(await t.kernel.decideApproval(row!.id, "approve", ownerCaller())).toMatchObject({
      status: "error",
      code: "conflict",
    });
  });
});
