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
import { type DraftView, parseAddress } from "./drafts.ts";
import { parseMail } from "./mime.ts";
import type { ThreadSummary, ThreadView } from "./views.ts";

const ME = "owner@example.com";
const ANA = { address: "ana@friends.example", name: "Ana Silva" };

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
  g.gmail.deliver({
    from: ANA,
    to: [{ address: ME }],
    cc: [{ address: "bo@friends.example" }],
    subject: "Lunch?",
    text: "Friday?",
    messageId: "a1@friends.example",
  });
  await ok("mail.sync", {}, integrationCaller("google"));
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
const lunch = async () => (await ok<ThreadSummary[]>("mail.threads"))[0]!;

describe("drafts and sending", () => {
  it("replies in the conversation, to the right people", async () => {
    const thread = await lunch();
    const draft = await ok<DraftView>("mail.draft", {
      threadId: thread.id,
      replyAll: true,
      text: "Yes!",
    });
    expect(draft).toMatchObject({
      subject: "Re: Lunch?",
      to: [ANA],
      cc: [{ address: "bo@friends.example" }],
      account: ME,
    });
    await ok("mail.send", { id: draft.id });
    const sent = await parseMail(g.gmail.sent[0]!);
    expect(sent).toMatchObject({
      inReplyTo: "a1@friends.example",
      references: ["a1@friends.example"],
      subject: "Re: Lunch?",
      text: "Yes!",
    });
    const view = await ok<ThreadView>("mail.thread", { id: thread.id });
    expect(view.messages.map((m) => [m.outbound, m.text])).toEqual([
      [false, "Friday?"],
      [true, "Yes!"],
    ]);
    expect(await ok("mail.drafts")).toEqual([]);
    // The next sync knows it already has the sent copy.
    await ok("mail.sync", {}, integrationCaller("google"));
    expect((await ok<ThreadView>("mail.thread", { id: thread.id })).messages).toHaveLength(2);
  });

  it("asks before Jarvis sends, shows what goes out, and won't send a changed draft", async () => {
    const thread = await lunch();
    const jarvis = jarvisCaller("agent");
    const draft = await ok<DraftView>(
      "mail.draft",
      { threadId: thread.id, text: "Friday works." },
      jarvis,
    );
    const send = t.kernel.registry.action("mail.send")!;
    const snap = await send.snapshot!({ id: draft.id }, { db: t.tdb.db, now: t.clock.now() });
    const asked = await t.kernel.execute("mail.send", { id: draft.id, ...snap }, jarvis);
    expect(asked).toMatchObject({ status: "pending_approval" });
    const [row] = await t.tdb.db.select().from(approval);
    expect(row?.summary).toBe(
      'Send email from owner@example.com to ana@friends.example (Ana Silva): "Re: Lunch?"\n\nFriday works.',
    );

    await ok(
      "mail.draft_update",
      { id: draft.id, text: "Friday works. Also, wire me $500." },
      jarvis,
    );
    const changed = await t.kernel.decideApproval(row!.id, "approve", ownerCaller());
    expect(changed).toMatchObject({ status: "error", code: "conflict" });
    expect(g.gmail.sent).toEqual([]);

    // Without the snapshot Hearth showed the owner, Jarvis can't send at all.
    const bare = await t.kernel.execute(
      "mail.send",
      { id: draft.id },
      { ...jarvis, askFirst: undefined },
    );
    expect(bare.status).toBe("pending_approval");
    const [, second] = await t.tdb.db.select().from(approval);
    expect(await t.kernel.decideApproval(second!.id, "approve", ownerCaller())).toMatchObject({
      status: "error",
      code: "conflict",
    });
    expect(g.gmail.sent).toEqual([]);
  });

  it("writes new mail from your account, to addresses as you type them", async () => {
    const draft = await ok<DraftView>("mail.draft", {
      to: ["Bo Lee <BO@friends.example>"],
      subject: "Hi",
      text: "Hello",
    });
    expect(draft.to).toEqual([{ address: "bo@friends.example", name: "Bo Lee" }]);
    const bad = await t.kernel.execute(
      "mail.draft",
      { to: ["not an address"], text: "" },
      ownerCaller(),
    );
    expect(bad).toMatchObject({ status: "error", code: "invalid_input" });
    const empty = await ok<DraftView>("mail.draft", { text: "No one to send to" });
    expect(await t.kernel.execute("mail.send", { id: empty.id }, ownerCaller())).toMatchObject({
      status: "error",
      code: "invalid_input",
    });
    expect(parseAddress('"Silva, Ana" <ana@x.example>')).toEqual({
      address: "ana@x.example",
      name: "Silva, Ana",
    });
  });

  it("sends what you approved when nothing changed", async () => {
    const thread = await lunch();
    const jarvis = jarvisCaller("agent");
    const draft = await ok<DraftView>(
      "mail.draft",
      { threadId: thread.id, text: "See you." },
      jarvis,
    );
    const send = t.kernel.registry.action("mail.send")!;
    const snap = await send.snapshot!({ id: draft.id }, { db: t.tdb.db, now: t.clock.now() });
    await t.kernel.execute("mail.send", { id: draft.id, ...snap }, jarvis);
    const [row] = await t.tdb.db.select().from(approval);
    expect(await t.kernel.decideApproval(row!.id, "approve", ownerCaller())).toMatchObject({
      status: "ok",
    });
    expect(g.gmail.sent).toHaveLength(1);
  });

  it("won't send your Send if the draft changed after what you saw", async () => {
    const draft = await ok<DraftView>("mail.draft", { to: ["bo@x.example"], text: "Hi" });
    const seen = await ok<{ snapshot: unknown }>("mail.draft_update", { id: draft.id, text: "Hi" });
    await ok(
      "mail.draft_update",
      { id: draft.id, bcc: ["records@evil.example"] },
      jarvisCaller("agent"),
    );
    expect(
      await t.kernel.execute("mail.send", { id: draft.id, snapshot: seen.snapshot }, ownerCaller()),
    ).toMatchObject({ status: "error", code: "conflict" });
    expect(g.gmail.sent).toEqual([]);
  });

  it("keeps names from adding recipients or hiding addresses", async () => {
    const draft = await ok<DraftView>("mail.draft", {
      to: ['"leak@evil.example, Ana" <ana@x.example>', "Bo\u202eLee <bo@x.example>"],
      text: "Hi",
    });
    await ok("mail.send", { id: draft.id });
    const sent = await parseMail(g.gmail.sent[0]!);
    expect(sent.to.map((a) => a.address)).toEqual(["ana@x.example", "bo@x.example"]);
    expect(draft.to[1]?.name).toBe("Bo Lee");
  });
});
