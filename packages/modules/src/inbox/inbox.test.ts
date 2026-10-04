// An approval's inbox card leaves only by deciding it (D58): done and snooze leave it waiting.
import { notification } from "@hearth/db";
import { type Caller, jarvisCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALL_MODULES } from "../index.ts";

let t: TestKernel;
beforeAll(async () => {
  t = await createTestKernel(ALL_MODULES);
});
afterAll(() => t.destroy());

const run = (name: string, input: unknown, caller: Caller = ownerCaller()) =>
  t.kernel.execute<Record<string, unknown>>(name, input, caller);
async function ok<T>(name: string, input: unknown): Promise<T> {
  const r = await run(name, input);
  if (r.status !== "ok") throw new Error(JSON.stringify(r));
  return r.result as T;
}

async function askToTrash() {
  const task = await ok<{ id: string }>("task.create", { title: "Old errand" });
  const asked = await run("entity.trash", { id: task.id }, jarvisCaller("owner"));
  if (asked.status !== "pending_approval") throw new Error(JSON.stringify(asked));
  const [card] = await t.tdb.db
    .select()
    .from(notification)
    .where(eq(notification.approvalId, asked.approvalId));
  return { approvalId: asked.approvalId, card: card! };
}

describe("approval cards in the inbox", () => {
  it("can't be marked done or snoozed while they wait, only seen", async () => {
    const { approvalId, card } = await askToTrash();
    const { id: otherId } = await ok<{ id: string }>("inbox.notify", { title: "Just so you know" });

    const marked = await run("inbox.mark", { ids: [card.id, otherId], state: "done" });
    expect(marked).toEqual({ status: "ok", result: { updated: 1 } });
    const snoozed = await run("inbox.snooze", { id: card.id, until: "2030-01-01T09:00:00Z" });
    expect(snoozed).toMatchObject({ status: "error", code: "conflict" });
    expect(await run("inbox.mark", { ids: [card.id], state: "seen" })).toMatchObject({
      result: { updated: 1 },
    });

    const rows = await ok<{ notification: { id: string }; approvalStatus: string }[]>(
      "inbox.list",
      {},
    );
    expect(rows.find((r) => r.notification.id === card.id)?.approvalStatus).toBe("pending");

    // Once decided, the card is done with it.
    await t.kernel.decideApproval(approvalId, "deny", ownerCaller());
    const [after] = await t.tdb.db.select().from(notification).where(eq(notification.id, card.id));
    expect(after?.state).toBe("done");
  });

  it("snoozes an ordinary item as before", async () => {
    const { id } = await ok<{ id: string }>("inbox.notify", { title: "Later" });
    expect(await run("inbox.snooze", { id, until: "2030-01-01T09:00:00Z" })).toEqual({
      status: "ok",
      result: { snoozed: true },
    });
  });
});
