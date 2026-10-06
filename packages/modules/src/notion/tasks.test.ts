import { randomBytes } from "node:crypto";
import { audit, notionAccount, notionTask } from "@hearth/db";
import { type Caller, integrationCaller, jarvisCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VAULT_SERVICE, Vault } from "../browser/vault.ts";
import { ALL_MODULES } from "../index.ts";
import { NOTION_SERVICE, NotionError } from "./api.ts";
import { pickColumns, ticketOf } from "./columns.ts";
import { FakeNotion, type FakeTicket, taskBoard } from "./fake.ts";

let t: TestKernel;
let n: FakeNotion;
const BOARD = "board-1";
const ME = "user-me";

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  n = new FakeNotion();
  n.board(BOARD, "Otopair");
  t.kernel.services[NOTION_SERVICE] = n.api();
  t.kernel.services[VAULT_SERVICE] = new Vault(randomBytes(32));
});
afterEach(() => t.destroy());

async function ok<T>(name: string, input: unknown = {}, caller: Caller = ownerCaller()) {
  const res = await t.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const sync = () =>
  ok<{ tickets: number; assigned: number; failed: string[] }>(
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
async function connected() {
  await ok("notion.connect", { token: n.token });
  await ok("notion.choose", { board: BOARD, you: ME });
}
const kinds = async () =>
  (await t.events()).filter((e) => e.kind.startsWith("notion.task_")).map((e) => e.kind);

describe("notion tasks", () => {
  it("connects with a sealed secret the audit log never sees, and Jarvis can't", async () => {
    expect(await ok("notion.connect", { token: n.token })).toEqual({ workspace: "Otopair" });
    const [a] = await t.tdb.db.select().from(notionAccount);
    expect(a?.token).not.toContain(n.token);
    const rows = await t.tdb.db.select().from(audit).where(eq(audit.action, "notion.connect"));
    expect(JSON.stringify(rows)).not.toContain(n.token);
    expect(
      (await t.kernel.execute("notion.connect", { token: n.token }, jarvisCaller("owner"))).status,
    ).toBe("denied");
    const bad = await t.kernel.execute(
      "notion.connect",
      { token: "ntn_wrongwrongwrongwrong1" },
      ownerCaller(),
    );
    expect(bad).toMatchObject({ status: "error", code: "invalid_input" });
    const choices = await ok<{ boards: { id: string }[]; people: { id: string }[] }>(
      "notion.choices",
    );
    expect(choices.boards.map((b) => b.id)).toEqual([BOARD]);
    expect(choices.people.map((p) => p.id)).toEqual([ME, "user-sam"]);
  });

  it("waits for you to pick the board and who you are, then brings in your open tickets quietly", async () => {
    await ok("notion.connect", { token: n.token });
    ticket("a");
    ticket("b", { status: "In progress", due: "2026-10-10" });
    ticket("done", { status: "Done" });
    ticket("ref", { status: "Reference Documents" });
    ticket("sams", { assignees: ["user-sam"] });
    expect((await sync()).tickets).toBe(0);
    const missing = await t.kernel.execute(
      "notion.choose",
      { board: BOARD, you: null },
      ownerCaller(),
    );
    expect(missing).toMatchObject({ status: "error", code: "invalid_input" });
    expect(await ok("notion.choose", { board: BOARD, you: ME })).toMatchObject({
      board: "Otopair",
      you: "Wally",
    });

    expect(await sync()).toMatchObject({ tickets: 4, assigned: 2 });
    const assigned = await t.events("notion.task_assigned");
    expect(assigned.map((e) => e.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "Ticket a", backfill: true, database: "Otopair" }),
        expect.objectContaining({
          title: "Ticket b",
          status: "In progress",
          dueAt: "2026-10-10",
          dueIsDate: true,
        }),
      ]),
    );
    expect(await kinds()).toEqual(["notion.task_assigned", "notion.task_assigned"]);
    // Nothing changed: nothing to say.
    await sync();
    expect(await kinds()).toHaveLength(2);
    expect(await ok("notion.status")).toMatchObject({
      connected: true,
      board: "Otopair",
      you: "Wally",
      open: 2,
      state: "ok",
    });
  });

  it("tells Jarvis when a ticket becomes yours, is done, or moves", async () => {
    await connected();
    ticket("a");
    await sync();
    const before = (await kinds()).length;

    ticket("new");
    ticket("a", { due: "2026-11-01" });
    await sync();
    const later = (await t.events()).filter((e) => e.kind.startsWith("notion.task_")).slice(before);
    expect(later.map((e) => [e.kind, e.payload.backfill, e.payload.changed])).toEqual(
      expect.arrayContaining([
        ["notion.task_assigned", false, undefined],
        ["notion.task_changed", false, ["due"]],
      ]),
    );

    ticket("a", { status: "Done", due: "2026-11-01" });
    await sync();
    expect((await t.events("notion.task_done")).map((e) => e.payload.title)).toEqual(["Ticket a"]);
    expect(await ok("notion.status")).toMatchObject({ open: 1 });
  });

  it("notices a ticket handed to someone else, and one handed back", async () => {
    await connected();
    ticket("a");
    ticket("b");
    await sync();
    ticket("a", { assignees: ["user-sam"] });
    ticket("b", { status: "Done" });
    expect(await sync()).toMatchObject({ unassigned: 1, done: 1 });
    // b is done: its task closed already, so handing it on says nothing more.
    ticket("b", { status: "Done", assignees: ["user-sam"] });
    expect(await sync()).toMatchObject({ unassigned: 0 });
    const rows = await t.tdb.db.select().from(notionTask);
    expect(rows.map((r) => r.assigned)).toEqual([false, false]);
    expect(await kinds()).toEqual([
      "notion.task_assigned",
      "notion.task_assigned",
      "notion.task_done",
      "notion.task_unassigned",
    ]);
    expect((await t.events("notion.task_unassigned"))[0]?.payload).toMatchObject({
      title: "Ticket a",
      backfill: false,
      database: "Otopair",
    });
    ticket("a");
    await sync();
    expect((await kinds()).at(-1)).toBe("notion.task_assigned");
  });

  it("stops at a revoked secret until you paste a new one, and lets a slowdown pass", async () => {
    await connected();
    ticket("a");
    n.failWith = new NotionError(429, "Notion asked Hearth to slow down.");
    expect((await sync()).failed).toEqual([]);
    expect((await t.tdb.db.select().from(notionAccount))[0]).toMatchObject({
      syncState: "ok",
      syncedAt: null,
    });

    n.failWith = new NotionError(401, "Notion doesn't accept this token.");
    await sync();
    expect((await t.tdb.db.select().from(notionAccount))[0]?.syncState).toBe("revoked");
    expect(await t.events("notion.sync_failed")).toMatchObject([{ payload: { reconnect: true } }]);
    const calls = n.calls.length;
    await sync();
    expect(n.calls.length).toBe(calls);

    n.failWith = null;
    await ok("notion.replace_token", { token: n.token });
    expect(await sync()).toMatchObject({ assigned: 1 });
  });

  it("describes a ticket for Jarvis with its link", async () => {
    await connected();
    ticket("a", { due: "2026-10-10" });
    await sync();
    const [row] = await t.tdb.db.select().from(notionTask);
    const text = await t.kernel.registry.describer("notion_task")!(row!.entityId, {
      db: t.tdb.db,
    } as never);
    expect(text).toContain("Ticket a");
    expect(text).toContain(row!.url);
    expect(text).toContain("due 2026-10-10");
  });
});

describe("notion columns", () => {
  it("reads Otopair's board: Assignee, Status with its Complete group, End date", () => {
    expect(pickColumns(taskBoard("x", "Otopair"))).toEqual({
      title: "Project name",
      assignee: "Assignee",
      status: "Status",
      doneOptions: ["Done", "Reference Documents", "Depricated"],
      doneBox: null,
      due: "End date",
    });
  });

  it("takes a personal list with a Done box and one date as every ticket yours", () => {
    const c = pickColumns({
      id: "x",
      title: "To Do",
      columns: [
        { name: "Name", type: "title" },
        { name: "Done", type: "checkbox" },
        { name: "When", type: "date" },
      ],
      complete: {},
    });
    expect(c).toMatchObject({ assignee: null, status: null, doneBox: "Done", due: "When" });
    const page = {
      id: "p",
      url: "",
      editedAt: new Date(),
      values: {
        Name: { type: "title" as const, text: " Call the bank " },
        Done: { type: "checkbox" as const, checked: true },
        When: { type: "date" as const, start: "2026-10-01T09:00:00.000-04:00", end: "2026-10-03" },
      },
    };
    expect(ticketOf(page, c)).toEqual({
      title: "Call the bank",
      assignees: [],
      status: null,
      done: true,
      dueAt: "2026-10-03",
      dueIsDate: true,
    });
  });
});
