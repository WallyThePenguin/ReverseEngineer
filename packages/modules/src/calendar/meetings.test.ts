// Meetings with guests wait for your yes, and the approval says which meeting and what its guests
// get (where, and the description) before you give it (D33). One asked before Hearth showed that
// isn't run, and one whose meeting changed since isn't either.
import { approval, notification } from "@hearth/db";
import { integrationCaller, jarvisCaller, ownerCaller, stableHash } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GOOGLE_SERVICE, SCOPES } from "../google/client.ts";
import { FakeGoogle } from "../google/fake.ts";
import { ALL_MODULES } from "../index.ts";
import type { EventView } from "./store.ts";

const ME = "owner@example.com";
const PRIYA = "priya@work.example";

let t: TestKernel;
let g: FakeGoogle;

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  g = new FakeGoogle(ME);
  g.clock = t.clock;
  t.kernel.services[GOOGLE_SERVICE] = g.client(t.tdb.db);
  const client = g.client(t.tdb.db);
  const url = new URL(await client.startSignIn(t.tdb.db, [...SCOPES.calendar]));
  await client.finishSignIn(t.tdb.db, url.searchParams.get("state")!, "the-code");
  await t.kernel.execute("calendar.sync", {}, integrationCaller("google"));
});
afterEach(() => t.destroy());

async function ok<T>(name: string, input: unknown): Promise<T> {
  const res = await t.kernel.execute<T>(name, input, ownerCaller());
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
/** Your own meeting with Priya, as you'd make it yourself. */
const offsitePrep = () =>
  ok<EventView>("calendar.schedule_meeting", {
    title: "Offsite prep",
    start: "2026-10-08T20:00:00Z",
    end: "2026-10-08T20:30:00Z",
    attendees: [PRIYA],
  });
const jarvis = (name: string, input: Record<string, unknown>) =>
  t.kernel.execute(name, input, jarvisCaller("owner"));
const asked = async () => {
  const [row] = await t.tdb.db.select().from(approval);
  const [card] = await t.tdb.db
    .select()
    .from(notification)
    .where(eq(notification.approvalId, row!.id));
  return { row: row!, card: card! };
};
const writes = () => g.calls.filter((c) => c.method !== "GET");

describe("a meeting's approval", () => {
  it("names the meeting Jarvis would change and shows what its guests get, before the yes", async () => {
    const ev = await offsitePrep();
    const before = writes().length;
    const res = await jarvis("calendar.update_meeting", {
      id: ev.id,
      location: "4th floor, big room",
      description: "Agenda:\n\n1. Budget\n2. Hiring",
    });
    expect(res).toMatchObject({ status: "pending_approval" });
    const { row, card } = await asked();
    const [what, ...rest] = row.summary.split("\n\n");
    expect(what).toMatch(
      /^Change "Offsite prep", .+: change where, change its description, telling its guests$/,
    );
    expect(rest.join("\n\n")).toBe("Where: 4th floor, big room\n\nAgenda:\n\n1. Budget\n2. Hiring");
    // The card on Today and in Updates: the meeting on its line, what guests get under it.
    expect(card.title).toContain('Change "Offsite prep"');
    expect(card.body).toMatch(/^Where: 4th floor, big room\n\nAgenda:\n\n1\. Budget\n2\. Hiring/);
    expect(writes()).toHaveLength(before);

    expect(await t.kernel.decideApproval(row.id, "approve", ownerCaller())).toMatchObject({
      status: "ok",
    });
    expect(writes().at(-1)).toMatchObject({
      method: "PATCH",
      body: { location: "4th floor, big room", description: "Agenda:\n\n1. Budget\n2. Hiring" },
    });
  });

  it("shows where and the description of a new meeting under the invitation", async () => {
    await jarvis("calendar.schedule_meeting", {
      title: "Lunch",
      start: "2026-10-09T16:00:00Z",
      end: "2026-10-09T17:00:00Z",
      attendees: [PRIYA],
      location: "Fenway Diner",
      description: "Bring the Q4 numbers.",
    });
    const { row } = await asked();
    expect(row.summary).toMatch(
      /^Invite priya@work\.example to "Lunch" .+\n\nWhere: Fenway Diner\n\nBring the Q4 numbers\.$/,
    );
    expect(await t.kernel.decideApproval(row.id, "approve", ownerCaller())).toMatchObject({
      status: "ok",
    });
    expect(writes().at(-1)).toMatchObject({ method: "POST" });
  });

  it("names the meeting it would cancel, and won't cancel one that changed since", async () => {
    const ev = await offsitePrep();
    await jarvis("calendar.cancel_meeting", { id: ev.id });
    const { row } = await asked();
    expect(row.summary).toMatch(/^Cancel "Offsite prep", .+ and tell its guests$/);
    // Moved in Google before you said yes.
    const moved = [...g.calendars.get(ME)!.events.values()][0]!;
    g.put(ME, {
      ...moved,
      start: { dateTime: "2026-10-09T20:00:00Z" },
      end: { dateTime: "2026-10-09T20:30:00Z" },
    });
    await t.kernel.execute("calendar.sync", {}, integrationCaller("google"));
    const before = writes().length;
    expect(await t.kernel.decideApproval(row.id, "approve", ownerCaller())).toMatchObject({
      status: "error",
      code: "conflict",
      message: expect.stringContaining("changed since you were asked"),
    });
    expect(writes()).toHaveLength(before);
  });

  it("won't run one asked before Hearth showed the meeting, and still lets you deny it", async () => {
    const ev = await offsitePrep();
    await jarvis("calendar.update_meeting", { id: ev.id, description: "New agenda" });
    await jarvis("calendar.cancel_meeting", { id: ev.id });
    // As a request from before the update was stored: no snapshot, its summary as it was then.
    const rows = await t.tdb.db.select().from(approval);
    for (const r of rows) {
      const { snapshot: _, ...old } = r.input as Record<string, unknown>;
      await t.tdb.db
        .update(approval)
        .set({
          input: old,
          inputHash: stableHash(old),
          summary: "Update a meeting, telling its guests",
        })
        .where(eq(approval.id, r.id));
    }
    const [update, cancel] = rows.sort((a, b) => a.action.localeCompare(b.action)).reverse();
    const before = writes().length;
    expect(await t.kernel.decideApproval(update!.id, "approve", ownerCaller())).toMatchObject({
      status: "error",
      code: "conflict",
      message: expect.stringContaining("Ask for it again"),
    });
    expect(writes()).toHaveLength(before);
    expect(await t.kernel.decideApproval(cancel!.id, "deny", ownerCaller())).toMatchObject({
      status: "ok",
      result: { decision: "denied" },
    });
  });
});
