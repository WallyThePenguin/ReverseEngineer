import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entity, link, mailOp, personEmail } from "@hearth/db";
import { type Caller, integrationCaller, jarvisCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GOOGLE_SERVICE, SCOPES } from "../google/client.ts";
import { FakeGoogle } from "../google/fake.ts";
import { ALL_MODULES } from "../index.ts";
import { BLOB_SERVICE, BlobStore } from "./blobs.ts";
import type { ThreadSummary, ThreadView } from "./views.ts";

const ME = "owner@example.com";
const ANA = { address: "ana@friends.example", name: "Ana Silva" };
const SHOP = { address: "deals@shop.example", name: "Shop" };

let t: TestKernel;
let g: FakeGoogle;
let dir: string;

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  g = new FakeGoogle(ME);
  g.grants = ["openid", "email", ...SCOPES.gmail];
  t.kernel.services[GOOGLE_SERVICE] = g.client();
  dir = await mkdtemp(join(tmpdir(), "hearth-blobs-"));
  t.kernel.services[BLOB_SERVICE] = new BlobStore(dir);
  const client = g.client();
  const url = new URL(await client.startSignIn(t.tdb.db, [...SCOPES.gmail]));
  await client.finishSignIn(t.tdb.db, url.searchParams.get("state")!, "the-code");
});
afterEach(async () => {
  await t.destroy();
  await rm(dir, { recursive: true, force: true });
});

async function ok<T>(
  name: string,
  input: unknown = {},
  caller: Caller = ownerCaller(),
): Promise<T> {
  const res = await t.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const sync = () =>
  ok<{ added: number; more: boolean }>("mail.sync", {}, integrationCaller("google"));
const inbox = (lane?: "signal" | "noise") =>
  ok<ThreadSummary[]>("mail.threads", lane ? { lane } : {});
const thread = (id: string) => ok<ThreadView>("mail.thread", { id });

describe("mail sync", () => {
  it("brings in recent mail as conversations threaded by their headers", async () => {
    g.gmail.deliver({
      from: ANA,
      subject: "Lunch?",
      text: "Friday at noon?",
      messageId: "a1@friends.example",
    });
    // A reply with a changed subject still joins the conversation it answers.
    g.gmail.deliver(
      {
        from: { address: ME },
        to: [ANA],
        subject: "Re: Lunch? (moved)",
        text: "Yes!\n> Friday at noon?",
        messageId: "me1@example.com",
        inReplyTo: "a1@friends.example",
        references: ["a1@friends.example"],
      },
      ["SENT"],
    );
    g.gmail.deliver(
      { from: SHOP, subject: "50% off", text: "Sale", html: "<p>Sale <b>today</b></p>" },
      ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"],
    );
    expect(await sync()).toMatchObject({ added: 3, more: false });

    const signal = await inbox("signal");
    expect(signal.map((x) => [x.subject, x.messageCount, x.unread])).toEqual([["Lunch?", 2, true]]);
    expect((await inbox("noise")).map((x) => x.subject)).toEqual(["50% off"]);
    const lunch = await thread(signal[0]!.id);
    expect(lunch.messages.map((m) => [m.from.address, m.outbound, m.text])).toEqual([
      [ANA.address, false, "Friday at noon?"],
      [ME, true, "Yes!\n> Friday at noon?"],
    ]);
    // Mail is written by other people, so it's recorded as coming from Google.
    const [row] = await t.tdb.db.select().from(entity).where(eq(entity.id, lunch.id));
    expect(row?.createdBy).toBe("integration:google");
    // Writing to Ana made her a person, linked to the messages.
    const [ana] = await t.tdb.db
      .select()
      .from(personEmail)
      .where(eq(personEmail.address, ANA.address));
    const [person] = await t.tdb.db.select().from(entity).where(eq(entity.id, ana!.personId));
    expect(person).toMatchObject({ type: "person", title: "Ana Silva" });
    const links = await t.tdb.db.select().from(link).where(eq(link.toId, ana!.personId));
    // Her earlier mail is linked to her as well.
    expect(links.map((l) => l.kind)).toEqual(["participant", "participant"]);
    // The first sync is history, not news.
    expect(await t.events("mail.received")).toEqual([]);
  });

  it("keeps the original, and shows HTML with nothing remote", async () => {
    g.gmail.deliver({
      from: SHOP,
      subject: "Your order",
      text: "Thanks",
      html: '<p>Thanks</p><img src="https://track.shop.example/pixel.gif">',
    });
    await sync();
    const [x] = await ok<ThreadSummary[]>("mail.threads", { view: "all" });
    const view = await thread(x!.id);
    expect(view.messages[0]).toMatchObject({ hasHtml: true, text: "Thanks" });
    const html = await ok<{ html: string; remoteImages: boolean }>("mail.html", {
      id: view.messages[0]!.id,
    });
    expect(html).toMatchObject({ remoteImages: true });
    expect(html.html).toContain("<p>Thanks</p>");
    const jarvis = await t.kernel.execute(
      "mail.html",
      { id: view.messages[0]!.id },
      integrationCaller("google"),
    );
    expect(jarvis.status).toBe("denied");
  });

  it("follows new mail, changes and deletions made in Gmail", async () => {
    const first = g.gmail.deliver({ from: ANA, subject: "Hello", text: "Hi" });
    await sync();
    const later = g.gmail.deliver({ from: ANA, subject: "Photos", text: "Here they are" });
    g.gmail.label(first, [], ["INBOX"]);
    await sync();
    expect((await inbox()).map((x) => x.subject)).toEqual(["Photos"]);
    const [received] = await t.events("mail.received");
    expect(received?.payload).toMatchObject({ from: ANA.address, subject: "Photos" });
    g.gmail.remove(later);
    await sync();
    expect(await inbox()).toEqual([]);
    expect(
      (await ok<ThreadSummary[]>("mail.threads", { view: "all" })).map((x) => x.subject),
    ).toEqual(["Hello"]);
  });

  it("starts over cleanly when Gmail's history runs out", async () => {
    g.gmail.deliver({ from: ANA, subject: "One", text: "1" });
    await sync();
    g.gmail.deliver({ from: ANA, subject: "Two", text: "2" });
    g.gmail.expireHistory();
    await sync();
    expect((await inbox()).map((x) => x.subject)).toEqual(["Two", "One"]);
  });
});

describe("triage", () => {
  it("archives, stars and reads at once, then tells Gmail", async () => {
    const id = g.gmail.deliver({ from: ANA, subject: "Plans", text: "?" });
    await sync();
    const [x] = await inbox();
    await ok("mail.archive", { ids: [x!.id] });
    await ok("mail.star", { ids: [x!.id] });
    await ok("mail.mark_read", { ids: [x!.id] });
    expect(await inbox()).toEqual([]);
    expect(g.gmail.messages.get(id)?.labelIds).toContain("INBOX");
    expect(await t.tdb.db.select().from(mailOp)).toHaveLength(3);
    await sync();
    expect(g.gmail.messages.get(id)?.labelIds.sort()).toEqual(["CATEGORY_PERSONAL", "STARRED"]);
    expect(await t.tdb.db.select().from(mailOp)).toEqual([]);
    const [starred] = await ok<ThreadSummary[]>("mail.threads", { view: "starred" });
    expect(starred).toMatchObject({ unread: false, inInbox: false });
  });

  it("puts a change back when Gmail refuses it", async () => {
    g.gmail.deliver({ from: ANA, subject: "Plans", text: "?" });
    await sync();
    const [x] = await inbox();
    await ok("mail.archive", { ids: [x!.id] });
    g.gmail.refuse = true;
    await sync();
    expect((await inbox()).map((y) => y.id)).toEqual([x!.id]);
    expect(await t.events("mail.change_failed")).toHaveLength(1);
  });

  it("asks before Jarvis trashes mail", async () => {
    g.gmail.deliver({ from: ANA, subject: "Old", text: "." });
    await sync();
    const [x] = await inbox();
    const res = await t.kernel.execute("mail.trash", { ids: [x!.id] }, jarvisCaller("agent"));
    expect(res.status).toBe("pending_approval");
  });

  it("learns Signal and Noise from your choices", async () => {
    g.gmail.deliver({ from: SHOP, subject: "Deal", text: "." }, ["INBOX", "CATEGORY_PROMOTIONS"]);
    g.gmail.deliver({ from: { address: "news@shop.example" }, subject: "News", text: "." });
    await sync();
    expect((await inbox("signal")).map((x) => x.subject)).toEqual(["News"]);
    expect(await ok("mail.set_lane", { sender: "@shop.example", lane: "noise" })).toMatchObject({
      pattern: "shop.example",
      moved: 1,
    });
    expect(await inbox("signal")).toEqual([]);
    // New mail from there goes straight to Noise; someone you've written to is Signal.
    g.gmail.deliver({ from: { address: "ana@shop.example" }, subject: "Hi from Ana", text: "." });
    await sync();
    expect((await inbox("noise")).map((x) => x.subject)).toContain("Hi from Ana");
    await ok("mail.set_lane", { sender: "ana@shop.example", lane: "signal" });
    expect((await inbox("signal")).map((x) => x.subject)).toEqual(["Hi from Ana"]);
  });

  it("finds mail by its words", async () => {
    g.gmail.deliver({ from: ANA, subject: "Trip", text: "The ferry leaves at nine." });
    g.gmail.deliver({ from: ANA, subject: "Other", text: "Nothing here." });
    await sync();
    const hits = await ok<ThreadSummary[]>("mail.search", { query: "ferry" });
    expect(hits.map((x) => x.subject)).toEqual(["Trip"]);
  });
});
