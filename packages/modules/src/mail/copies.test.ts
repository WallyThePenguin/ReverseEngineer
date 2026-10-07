// The same email to two of your accounts is one message: one conversation, one reply. Each
// account keeps its copy, so reading and archiving reach both Gmails. A Message-ID alone doesn't
// make a copy: anyone who got the email can reuse it.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mailMessage } from "@hearth/db";
import { integrationCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GOOGLE_SERVICE, SCOPES } from "../google/client.ts";
import { FakeGoogle } from "../google/fake.ts";
import type { FakeGmail } from "../google/fake-gmail.ts";
import { ALL_MODULES } from "../index.ts";
import { BLOB_SERVICE, BlobStore } from "./blobs.ts";
import type { DraftView } from "./drafts.ts";
import type { ThreadSummary, ThreadView } from "./views.ts";

const HOME = "sam@home.example";
const WORK = "sam@work.example";
const ANA = { address: "ana@friends.example", name: "Ana Silva" };
const MALLORY = { address: "mallory@elsewhere.example", name: "Ana Silva" };
/** Gmail marks it important, so it needs a reply whoever Ana is. */
const IMPORTANT = ["INBOX", "UNREAD", "CATEGORY_PERSONAL", "IMPORTANT"];
const DINNER = {
  from: ANA,
  to: [{ address: HOME }, { address: WORK }],
  subject: "Dinner?",
  text: "Friday at 8?",
  messageId: "dinner-1@friends.example",
  date: new Date(Date.UTC(2026, 9, 1, 9, 30, 15)),
};

let t: TestKernel;
let g: FakeGoogle;
let dir: string;
let home: FakeGmail;
let work: FakeGmail;

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  g = new FakeGoogle(HOME);
  g.clock = t.clock;
  g.grants = ["openid", "email", ...SCOPES.gmail];
  t.kernel.services[GOOGLE_SERVICE] = g.client();
  dir = await mkdtemp(join(tmpdir(), "hearth-blobs-"));
  t.kernel.services[BLOB_SERVICE] = new BlobStore(dir);
  await connect();
  work = g.addAccount(WORK).gmail;
  g.signingIn = WORK;
  await connect();
  home = g.gmail;
});
afterEach(async () => {
  await t.destroy();
  await rm(dir, { recursive: true, force: true });
});

async function connect() {
  const client = g.client();
  const url = new URL(await client.startSignIn(t.tdb.db, [...SCOPES.gmail]));
  await client.finishSignIn(t.tdb.db, url.searchParams.get("state")!, "the-code");
}
async function ok<T>(name: string, input: unknown = {}, caller = ownerCaller()): Promise<T> {
  const res = await t.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const sync = () => ok("mail.sync", {}, integrationCaller("google"));
const threads = () => ok<ThreadSummary[]>("mail.threads", { view: "all" });
const senders = async (id: string) =>
  (await ok<ThreadView>("mail.thread", { id })).messages.map((m) => m.from.address);
const flags = (box: FakeGmail, id: string) => box.messages.get(id)!.labelIds;

describe("an email to two of your accounts", () => {
  it("shows once, gets one reply, and reading or archiving it reaches both", async () => {
    const copies = [home.deliver(DINNER, IMPORTANT), work.deliver(DINNER, IMPORTANT)];
    await sync();
    const [thread, ...others] = await threads();
    expect(others).toEqual([]);
    expect(thread).toMatchObject({ subject: "Dinner?", messageCount: 1, waiting: "you" });
    expect(await senders(thread!.id)).toEqual([ANA.address]);
    // Both copies are kept: each account has its own.
    expect(await t.tdb.db.select().from(mailMessage)).toHaveLength(2);

    // A reply goes from the account it came to first, as the conversation shows it.
    const draft = await ok<DraftView>("mail.draft", { threadId: thread!.id, text: "Yes!" });
    expect(draft.account).toBe(thread!.account);
    expect(draft.to.map((a) => a.address)).toEqual([ANA.address]);

    await ok("mail.mark_read", { ids: [thread!.id] });
    await ok("mail.archive", { ids: [thread!.id] });
    await sync();
    for (const [box, id] of [
      [home, copies[0]!],
      [work, copies[1]!],
    ] as const) {
      expect(flags(box, id)).not.toContain("INBOX");
      expect(flags(box, id)).not.toContain("UNREAD");
    }

    // Ana's answer to both joins the conversation once too.
    const again = { ...DINNER, subject: "Re: Dinner?", text: "Or 9?", messageId: "dinner-2@x" };
    const answer = { ...again, inReplyTo: DINNER.messageId, references: [DINNER.messageId] };
    home.deliver(answer, IMPORTANT);
    work.deliver(answer, IMPORTANT);
    await sync();
    expect(await threads()).toMatchObject([{ id: thread!.id, messageCount: 2 }]);
    expect(await senders(thread!.id)).toEqual([ANA.address, ANA.address]);
  });

  it("keeps apart a message that reuses its Message-ID but isn't the same email", async () => {
    home.deliver(DINNER, IMPORTANT);
    // Someone who got it sends their own with its Message-ID to your other account: another
    // sender, or the same sender with another subject or at another time. None is hidden.
    work.deliver({ ...DINNER, from: MALLORY, text: "Pay here" }, IMPORTANT);
    work.deliver({ ...DINNER, subject: "Dinner moved" }, IMPORTANT);
    work.deliver({ ...DINNER, date: new Date(DINNER.date.getTime() + 60_000) }, IMPORTANT);
    await sync();
    const all = await threads();
    expect(all).toHaveLength(2);
    const byAccount = Object.fromEntries(all.map((x) => [x.account, x]));
    expect(await senders(byAccount[HOME]!.id)).toEqual([ANA.address]);
    expect((await senders(byAccount[WORK]!.id)).sort()).toEqual([
      ANA.address,
      ANA.address,
      MALLORY.address,
    ]);
    expect(byAccount[WORK]).toMatchObject({ messageCount: 3 });
  });
});
