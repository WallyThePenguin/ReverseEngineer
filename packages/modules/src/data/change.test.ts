// Changes in a data source (D73): only on a source you allow, each on your yes, with the card
// showing the function, its args and the deployment, and refused if the source changed since.
import { randomBytes } from "node:crypto";
import { approval, dataSource } from "@hearth/db";
import { type Caller, jarvisCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VAULT_SERVICE, Vault } from "../browser/vault.ts";
import { ALL_MODULES } from "../index.ts";
import { ConvexError, FakeConvex } from "./convex.ts";
import { CONVEX_SERVICE } from "./index.ts";

let t: TestKernel;
let convex: FakeConvex;
let id: string;
const jarvis = jarvisCaller("owner");
const refund = { source: "", kind: "mutation", path: "orders:refund", args: { order: "o7" } };

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  t.kernel.services[VAULT_SERVICE] = new Vault(randomBytes(32));
  convex = new FakeConvex();
  t.kernel.services[CONVEX_SERVICE] = convex.api();
  convex.functions = [
    { identifier: "orders.js:byCustomer", functionType: "Query" },
    { identifier: "orders.js:refund", functionType: "Mutation" },
    { identifier: "mail.js:receipt", functionType: "Action" },
  ];
  convex.changes.set("orders:refund", { kind: "mutation", run: (a) => ({ refunded: a.order }) });
  convex.changes.set("mail:receipt", { kind: "action", run: () => "sent" });
  ({ id } = await ok<{ id: string }>("data.connect", {
    label: "Shop",
    address: convex.address,
    key: convex.key,
  }));
  refund.source = id;
});
afterEach(() => t.destroy());

const run = (name: string, input: unknown, caller: Caller = ownerCaller("ui")) =>
  t.kernel.execute(name, input, caller);
async function ok<T>(name: string, input: unknown, caller?: Caller): Promise<T> {
  const res = await run(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result as T;
}
/** Asks as Jarvis, and gives back the card's text and its id. */
async function ask(input: unknown) {
  const res = await run("data.change", input, jarvis);
  expect(res).toMatchObject({ status: "pending_approval" });
  const approvalId = (res as { approvalId: string }).approvalId;
  const [row] = await t.tdb.db.select().from(approval).where(eq(approval.id, approvalId));
  return { approvalId, summary: row!.summary };
}
const yes = (approvalId: string) => t.kernel.decideApproval(approvalId, "approve", ownerCaller());
const changed = () => convex.calls.filter((c) => c.kind);

describe("changing a data source", () => {
  it("changes nothing on a read-only source, and doesn't tell Jarvis what could", async () => {
    expect(await run("data.change", refund, jarvis)).toMatchObject({
      status: "error",
      message: expect.stringMatching(/Shop is read-only/),
    });
    const fns = await ok<{ functions: { path: string }[] }>(
      "data.functions",
      { source: id },
      jarvis,
    );
    expect(fns.functions.map((f) => f.path)).toEqual(["orders:byCustomer"]);
    expect(changed()).toEqual([]);
  });

  it("asks you first, showing the function, its args and the deployment", async () => {
    await ok("data.set_mode", { source: id, mode: "approve_writes" });
    const fns = await ok<{ functions: { path: string; type: string }[] }>(
      "data.functions",
      { source: id },
      jarvis,
    );
    expect(fns.functions.map((f) => [f.path, f.type])).toEqual([
      ["orders:byCustomer", "query"],
      ["orders:refund", "mutation"],
      ["mail:receipt", "action"],
    ]);
    const { approvalId, summary } = await ask(refund);
    expect(summary).toBe(
      'Run the mutation orders:refund on Shop (happy-otter-123, with a development deploy key)\n\nArgs: {\n  "order": "o7"\n}',
    );
    expect(changed()).toEqual([]);
    expect(await yes(approvalId)).toMatchObject({
      status: "ok",
      result: { source: "Shop", value: { refunded: "o7" }, outside: true },
    });
    expect(changed()).toEqual([{ kind: "mutation", path: "orders:refund", args: { order: "o7" } }]);

    const action = await ask({ ...refund, kind: "action", path: "mail:receipt", args: {} });
    expect(action.summary).toMatch(/^Run the action mail:receipt .+\n\nAn action can also reach/);
  });

  it("changes nothing on your yes when the source changed since you were asked", async () => {
    await ok("data.set_mode", { source: id, mode: "approve_writes" });
    const first = await ask(refund);
    await ok("data.set_mode", { source: id, mode: "read" });
    expect(await yes(first.approvalId)).toMatchObject({ status: "error", code: "forbidden" });
    await ok("data.set_mode", { source: id, mode: "approve_writes" });
    const second = await ask(refund);
    await t.tdb.db
      .update(dataSource)
      .set({ address: "https://other-place-456.convex.cloud" })
      .where(eq(dataSource.id, id));
    expect(await yes(second.approvalId)).toMatchObject({ status: "error", code: "conflict" });
    expect(changed()).toEqual([]);
  });

  it("never says try again when Convex didn't answer: the change may have been made", async () => {
    await ok("data.set_mode", { source: id, mode: "approve_writes" });
    convex.failWith = new ConvexError("unreachable", "Convex took longer than 15 seconds.");
    expect(await run("data.change", refund)).toMatchObject({
      status: "error",
      code: "unavailable",
      message: expect.stringMatching(/can't tell whether the change was made/),
    });
    convex.failWith = null;
    // A mutation called as an action: Convex finds no such action.
    expect(await run("data.change", { ...refund, kind: "action" })).toMatchObject({
      status: "error",
      code: "failed",
    });
  });
});
