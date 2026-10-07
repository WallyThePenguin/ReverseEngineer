import { randomBytes } from "node:crypto";
import { renderMention } from "@hearth/core";
import { entity, task } from "@hearth/db";
import { type Caller, integrationCaller, ownerCaller, systemCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VAULT_SERVICE, Vault } from "../browser/vault.ts";
import { ALL_MODULES } from "../index.ts";
import { NOTION_SERVICE } from "./api.ts";
import { FakeNotion, type FakeTicket } from "./fake.ts";
import { notionToTasks } from "./to-tasks.ts";

let t: TestKernel;
let n: FakeNotion;
/** The last event notion.to_tasks has been through. */
let seen = 0;
const BOARD = "board-1";
const ME = "user-me";

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  n = new FakeNotion();
  n.board(BOARD, "Otopair");
  t.kernel.services[NOTION_SERVICE] = n.api();
  t.kernel.services[VAULT_SERVICE] = new Vault(randomBytes(32));
  seen = 0;
  await ok("notion.connect", { token: n.token });
  await ok("notion.choose", { board: BOARD, you: ME });
});
afterEach(() => t.destroy());

async function ok<T>(name: string, input: unknown = {}, caller: Caller = ownerCaller()) {
  const res = await t.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const sync = () =>
  ok<{ assigned: number; done: number; unassigned: number }>(
    "notion.sync",
    {},
    integrationCaller("notion"),
  );
const ticket = (id: string, p: Partial<FakeTicket> = {}) => {
  t.clock.advance(1000);
  n.put(BOARD, {
    id,
    title: `Ticket ${id}`,
    assignees: [ME],
    status: "Not started",
    editedAt: t.clock.now(),
    ...p,
  });
};
const news = async () =>
  (await t.events()).filter((e) => notionToTasks.on.includes(e.kind) && e.seq > seen);
/** Runs notion.to_tasks over the news since last time, as the reflex engine does an "always" one. */
async function settle() {
  for (const e of await news()) {
    seen = e.seq;
    for (const o of await notionToTasks.run(e, { db: t.tdb.db, now: t.clock.now() }))
      if (o.kind === "act") await ok(o.action, o.input, systemCaller());
  }
}
/** Loses the news since last time, as a failed task.create (or a pause, before) did. */
const lose = async () => {
  seen = (await t.events()).at(-1)!.seq;
};
const tasks = () =>
  t.tdb.db
    .select({ id: entity.id, title: entity.title, status: task.status, outside: entity.outside })
    .from(task)
    .innerJoin(entity, eq(entity.id, task.entityId))
    .orderBy(asc(entity.title));

describe("notion tickets as tasks", () => {
  it("keeps your tasks in step without a model turn, so a pause doesn't hold them", async () => {
    // The engine skips only proactive reflexes while Jarvis is paused.
    expect(notionToTasks.mode).toBe("always");
    ticket("a");
    await sync();
    await settle();
    // The ticket's title is someone else's words (D58).
    expect(await tasks()).toEqual([expect.objectContaining({ title: "Ticket a", outside: true })]);
    ticket("a", { title: "Ticket a, renamed", due: "2026-11-01" });
    await sync();
    await settle();
    ticket("a", { title: "Ticket a, renamed", due: "2026-11-01", status: "Done" });
    await sync();
    await settle();
    expect(await tasks()).toEqual([
      expect.objectContaining({ title: "Ticket a, renamed", status: "completed" }),
    ]);
  });

  it("makes the task a ticket's news didn't, on the next round, and only once", async () => {
    ticket("a");
    await sync();
    await lose();
    ticket("b");
    expect(await sync()).toMatchObject({ assigned: 2 });
    expect((await news()).map((e) => [e.payload.title, e.payload.caughtUp])).toEqual([
      ["Ticket b", undefined],
      ["Ticket a", true],
    ]);
    await settle();
    expect((await tasks()).map((k) => k.title)).toEqual(["Ticket a", "Ticket b"]);
    expect(await sync()).toMatchObject({ assigned: 0 });
    expect(await news()).toEqual([]);
  });

  it("closes a task left open after its ticket closed or left you, and keeps what you did", async () => {
    for (const id of ["a", "b", "c", "d"]) ticket(id);
    await sync();
    await settle();
    const [a, b, c] = await tasks();
    ticket("a", { status: "Done" });
    ticket("b", { assignees: ["user-sam"] });
    await sync();
    await lose();
    // You closed c's task and put d's in the trash, with both tickets still open.
    await ok("task.update", { id: c!.id, status: "completed" });
    await ok("entity.trash", { id: (await tasks())[3]!.id });
    expect(await sync()).toMatchObject({ assigned: 0, done: 1, unassigned: 1 });
    await settle();
    expect(await tasks()).toEqual([
      expect.objectContaining({ id: a!.id, status: "completed" }),
      expect.objectContaining({ id: b!.id, status: "canceled" }),
      expect.objectContaining({ id: c!.id, status: "completed" }),
      expect.objectContaining({ title: "Ticket d", status: "not_started" }),
    ]);
    // d's task is still in the trash: the ticket didn't get another.
    expect(await sync()).toMatchObject({ assigned: 0, done: 0, unassigned: 0 });
  });

  it("leaves the title of a task you wrote yourself about a ticket", async () => {
    ticket("a");
    await sync();
    await lose();
    const id = (await t.events("notion.task_assigned"))[0]!.entityId!;
    const ref = renderMention({ type: "notion_task", id, label: "Notion ticket" });
    const mine = await ok<{ id: string }>("task.create", { title: "Mine", body: `See ${ref}.` });
    ticket("a", { title: "Ticket a, renamed", due: "2026-11-01" });
    await sync();
    await settle();
    expect(await tasks()).toEqual([
      expect.objectContaining({ id: mine.id, title: "Mine", outside: false }),
    ]);
  });
});
