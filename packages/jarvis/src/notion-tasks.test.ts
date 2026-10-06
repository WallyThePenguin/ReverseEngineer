// Notion tickets as Hearth tasks, end to end and without a model turn: your open tickets come in
// as tasks when you connect, a new one becomes a task, a done one closes it, a reopened one opens
// it again, and a new title or due date carries over. Nothing while Jarvis is paused.
import { randomBytes } from "node:crypto";
import { entity, link } from "@hearth/db";
import { type Caller, integrationCaller, ownerCaller } from "@hearth/kernel";
import { FakeNotion, NOTION_SERVICE, type TaskView, VAULT_SERVICE, Vault } from "@hearth/modules";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJarvisHarness, type JarvisHarness } from "./testing.ts";

let h: JarvisHarness;
let n: FakeNotion;
const BOARD = "board-1";
const ME = "user-me";

async function ok<T>(name: string, input: unknown = {}, caller: Caller = ownerCaller()) {
  const res = await h.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
async function sync() {
  await ok("notion.sync", {}, integrationCaller("notion"));
  await h.settle();
}
const ticket = (id: string, p: { title?: string; status?: string; due?: string | null } = {}) => {
  h.clock.advance(1000);
  n.put(BOARD, {
    id,
    title: p.title ?? `Ticket ${id}`,
    assignees: [ME],
    status: p.status ?? "Not started",
    due: p.due ?? null,
    editedAt: h.clock.now(),
  });
};
/** Every task, by title. */
const tasks = async () =>
  (await ok<TaskView[]>("task.list", { status: ["not_started", "completed"] }))
    .map((t) => [t.title, t.status, t.dueAt ? new Date(t.dueAt).toISOString() : null, t.dueIsDate])
    .sort((x, y) => String(x[0]).localeCompare(String(y[0])));

beforeEach(async () => {
  h = await createJarvisHarness("2026-10-01T14:00:00Z"); // Thursday 10 a.m. Eastern
  n = new FakeNotion();
  n.board(BOARD, "Otopair");
  h.kernel.services[NOTION_SERVICE] = n.api();
  h.kernel.services[VAULT_SERVICE] = new Vault(randomBytes(32));
  await ok("notion.connect", { token: n.token });
  await ok("notion.choose", { board: BOARD, you: ME });
});
afterEach(() => h.destroy());

describe("Notion tickets as tasks", () => {
  it("brings in your tickets and keeps their tasks in step, with no model turn", async () => {
    ticket("a", { title: "Ship the invoice page", due: "2026-10-10" });
    ticket("b", { status: "Done" });
    await sync();
    expect(await tasks()).toEqual([
      ["Ship the invoice page", "not_started", "2026-10-10T04:00:00.000Z", true],
    ]);
    const [a] = await ok<TaskView[]>("task.list", {});
    const [ref] = await h.tdb.db.select().from(link).where(eq(link.fromId, a!.id));
    expect(ref).toMatchObject({ kind: "mention" });
    // Its title is someone else's words: whoever reads the task later knows it.
    const [row] = await h.tdb.db.select().from(entity).where(eq(entity.id, a!.id));
    expect(row).toMatchObject({ createdBy: "jarvis", outside: true });

    ticket("c", { title: "Review the deck", due: "2026-10-03T15:00:00.000Z" });
    ticket("a", { title: "Ship the invoice page v2", due: null });
    await sync();
    expect(await tasks()).toEqual([
      ["Review the deck", "not_started", "2026-10-03T15:00:00.000Z", false],
      ["Ship the invoice page v2", "not_started", null, false],
    ]);

    ticket("a", { title: "Ship the invoice page v2", status: "Done" });
    await sync();
    expect((await tasks())[1]).toEqual(["Ship the invoice page v2", "completed", null, false]);
    ticket("a", { title: "Ship the invoice page v2", status: "In progress" });
    await sync();
    expect((await tasks())[1]).toEqual(["Ship the invoice page v2", "not_started", null, false]);
    expect(await tasks()).toHaveLength(2);
    expect(h.brain.requests).toEqual([]);
  });

  it("makes nothing while Jarvis is paused, and catches up on the next change", async () => {
    await ok("jarvis.pause", {});
    ticket("a", { title: "Fix the login bug" });
    await sync();
    expect(await tasks()).toEqual([]);
    await ok("jarvis.resume", {});
    ticket("a", { title: "Fix the login bug today" });
    await sync();
    expect(await tasks()).toEqual([["Fix the login bug today", "not_started", null, false]]);
  });
});
