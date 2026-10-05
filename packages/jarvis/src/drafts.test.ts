// The morning's reply drafts, end to end: at 7:45 Jarvis drafts the replies you owe, in a thread
// of its own that stays out of your chat list, sends nothing, and the 8:15 brief counts them.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jarvisTurn } from "@hearth/db";
import { type Caller, integrationCaller, ownerCaller } from "@hearth/kernel";
import {
  BLOB_SERVICE,
  BlobStore,
  type DraftView,
  GOOGLE_SERVICE,
  SCOPES,
  type ThreadSummary,
} from "@hearth/modules";
import { FakeGoogle } from "@hearth/modules/google-testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJarvisHarness, type JarvisHarness } from "./testing.ts";

const ME = "owner@example.com";
const ANA = { address: "ana@friends.example", name: "Ana Silva" };

let h: JarvisHarness;
let g: FakeGoogle;
let dir: string;

async function ok<T>(name: string, input: unknown = {}, caller: Caller = ownerCaller()) {
  const res = await h.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}

beforeEach(async () => {
  h = await createJarvisHarness("2026-10-01T14:00:00Z"); // Thursday 10 a.m.
  g = new FakeGoogle(ME);
  g.clock = h.clock;
  g.grants = ["openid", "email", ...SCOPES.gmail];
  h.kernel.services[GOOGLE_SERVICE] = g.client();
  dir = await mkdtemp(join(tmpdir(), "hearth-blobs-"));
  h.kernel.services[BLOB_SERVICE] = new BlobStore(dir);
  const client = g.client();
  const url = new URL(await client.startSignIn(h.tdb.db, [...SCOPES.gmail]));
  await client.finishSignIn(h.tdb.db, url.searchParams.get("state")!, "the-code");
});
afterEach(async () => {
  await h.destroy();
  await rm(dir, { recursive: true, force: true });
});

describe("morning reply drafts", () => {
  it("drafts what you owe at 7:45, out of your chat list, and the brief counts it", async () => {
    g.gmail.deliver({ from: ANA, subject: "Dinner?", text: "Are you free Friday?" }, [
      "INBOX",
      "UNREAD",
      "CATEGORY_PERSONAL",
      "IMPORTANT",
    ]);
    await ok("mail.sync", {}, integrationCaller("google"));
    const [dinner] = await ok<ThreadSummary[]>("mail.threads", { waiting: "you" });
    await h.settle();
    // Only the drafting turn drafts; the night's other routines just finish.
    h.brain.otherwise((req) =>
      req.prompt.includes("waiting on the owner's reply")
        ? [
            { call: "mail_thread", input: { id: dinner!.id } },
            { call: "mail_draft", input: { threadId: dinner!.id, text: "Friday works." } },
            { say: "" },
          ]
        : [{ say: "OK." }],
    );
    h.clock.set("2026-10-02T11:45:10Z"); // Friday 7:45 a.m.
    await h.settle();

    const turns = await h.tdb.db.select().from(jarvisTurn);
    const drafting = turns.find((t) => t.context.routine === "reply_drafts");
    expect(drafting).toMatchObject({
      mode: "proactive",
      lane: "fast",
      origin: "untrusted",
      status: "done",
    });
    expect(await ok<DraftView[]>("mail.drafts")).toMatchObject([
      { threadId: dinner!.id, by: "jarvis", text: "Friday works." },
    ]);
    expect(g.gmail.sent).toEqual([]);
    // Its thread is named for what it did, and only shows when you ask for Jarvis's own runs.
    const thread = await ok<{ conversation: { title: string } }>("conversation.get", {
      id: drafting!.conversationId,
    });
    expect(thread.conversation.title).toMatch(/^Reply drafts, /);
    expect(await ok("conversation.list", {})).toEqual([]);
    const runs = await ok<{ id: string }[]>("conversation.list", { routines: true });
    expect(runs.map((c) => c.id)).toContain(drafting!.conversationId);

    h.clock.set("2026-10-02T12:15:10Z"); // 8:15 a.m.: the brief
    await h.settle();
    const brief = h.brain.requests.find((r) => r.prompt.includes("time for the morning brief"));
    expect(brief?.prompt).toContain("1 reply drafted, waiting in Mail for you to send.");
  });
});
