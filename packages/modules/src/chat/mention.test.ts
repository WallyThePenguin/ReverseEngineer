// @Jarvis in a live note (D59): each mention keeps its own anchor however the note changes, so
// Jarvis neither re-answers an old question nor misses a new one; and it waits for the request
// to be written before reading it.
import { JARVIS_ENTITY_ID, renderMention } from "@hearth/core";
import { link } from "@hearth/db";
import { type HearthEvent, ownerCaller, type ReadContext } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL_MODULES } from "../index.ts";
import { answerMention, MENTION_MAX_WAIT_MS, MENTION_SETTLE_MS } from "./mention.ts";

let t: TestKernel;
beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
});
afterEach(() => t.destroy());

async function ok<T>(name: string, input: unknown): Promise<T> {
  const res = await t.kernel.execute<T>(name, input, ownerCaller());
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const read = (): ReadContext => ({ db: t.tdb.db, now: t.clock.now() });
const jarvis = (mid: string) =>
  renderMention({ type: "agent", id: JARVIS_ENTITY_ID, label: "Jarvis", mid });
const mentioned = async (id: string) =>
  (await t.events("jarvis.mentioned")).filter((e) => e.entityId === id);
/** What the reflex does when its check comes due. */
const check = (payload: Record<string, unknown>) =>
  answerMention.onCheck!(payload, { ...read(), event: {} as HearthEvent });

describe("@Jarvis in a note", () => {
  it("asks only the new question when one is written above an answered one", async () => {
    const note = await ok<{ id: string }>("note.create", {
      title: "Trip",
      body: `${jarvis("a1")} book the hotel`,
    });
    await ok("note.update", {
      id: note.id,
      body: `${jarvis("b2")} and a car\n\n${jarvis("a1")} book the hotel`,
    });
    const events = await mentioned(note.id);
    expect(events.map((e) => e.payload.anchor)).toEqual(["mid:a1", "mid:b2"]);
    const anchors = await t.tdb.db
      .select({ anchor: link.anchor })
      .from(link)
      .where(eq(link.fromId, note.id));
    expect(anchors.map((a) => a.anchor).sort()).toEqual(["mid:a1", "mid:b2"]);
  });

  it("waits for the note to be still, then answers the request as it reads by then", async () => {
    const note = await ok<{ id: string }>("note.create", {
      title: "Plan",
      body: `${jarvis("q1")} please`,
    });
    const [event] = await mentioned(note.id);
    const [wait] = await answerMention.run(event!, read());
    expect(wait).toMatchObject({ kind: "check_later", key: `${note.id}:mid:q1` });
    const payload = (wait as { payload: Record<string, unknown> }).payload;

    // Still typing: it looks again later rather than answering "please".
    t.clock.advance(5_000);
    await ok("note.update", { id: note.id, body: `${jarvis("q1")} please draft the agenda` });
    t.clock.advance(MENTION_SETTLE_MS - 1_000);
    expect(await check(payload)).toMatchObject([{ kind: "check_later" }]);

    t.clock.advance(2_000);
    const [turn] = await check(payload);
    expect(turn).toMatchObject({ kind: "turn", dedupeKey: `mention:${note.id}:mid:q1` });
    expect((turn as { prompt: string }).prompt).toContain("@Jarvis please draft the agenda");
    expect(turn).not.toHaveProperty("untrusted");
  });

  it("answers anyway after a minute of non-stop typing, and not at all once it's deleted", async () => {
    const note = await ok<{ id: string }>("note.create", {
      title: "Log",
      body: `${jarvis("z")} x`,
    });
    const [event] = await mentioned(note.id);
    const [wait] = await answerMention.run({ ...event!, origin: "untrusted" }, read());
    const payload = (wait as { payload: Record<string, unknown> }).payload;
    t.clock.advance(MENTION_MAX_WAIT_MS);
    await ok("note.update", { id: note.id, body: `${jarvis("z")} x y` });
    // Written outside Hearth: the answer's turn is untrusted too (D25).
    expect(await check(payload)).toMatchObject([{ kind: "turn", untrusted: true }]);
    await ok("note.update", { id: note.id, body: "never mind" });
    t.clock.advance(MENTION_SETTLE_MS);
    expect(await check(payload)).toEqual([]);
  });

  it("still answers a comment at once", async () => {
    const task = await ok<{ id: string }>("task.create", { title: "Trip" });
    const comment = await ok<{ id: string }>("comment.create", {
      parentId: task.id,
      body: `${jarvis("c")} find flights`,
    });
    const [event] = await mentioned(comment.id);
    expect(await answerMention.run(event!, read())).toMatchObject([{ kind: "turn" }]);
  });
});
