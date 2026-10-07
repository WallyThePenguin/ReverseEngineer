// Data connectors (D73), against a Convex deployment in memory: a deploy key is connected sealed,
// for you alone; Jarvis reads tables, documents and the deployment's own queries, capped and as
// outside content; and nothing else of the deployment's runs.
import { randomBytes } from "node:crypto";
import { audit, dataSource } from "@hearth/db";
import { type Caller, jarvisCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VAULT_SERVICE, Vault } from "../browser/vault.ts";
import { ALL_MODULES } from "../index.ts";
import { ConvexError, deploymentAddress, describeKey, FakeConvex } from "./convex.ts";
import { CONVEX_SERVICE, dataModule, limits } from "./index.ts";

let t: TestKernel;
let convex: FakeConvex;
const saved = { ...limits };
beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  t.kernel.services[VAULT_SERVICE] = new Vault(randomBytes(32));
  convex = new FakeConvex();
  t.kernel.services[CONVEX_SERVICE] = convex.api();
  convex.tables.set("orders", {
    documents: Array.from({ length: 30 }, (_, n) => ({
      _id: `o${n + 1}`,
      _creationTime: 1_700_000_000_000 + n,
      customer: `customer ${n + 1}`,
      note: "x".repeat(3_000),
    })),
    schema: { type: "object", value: { customer: { fieldType: { type: "string" } } } },
  });
  convex.tables.set("events", { documents: [] });
});
afterEach(async () => {
  Object.assign(limits, saved);
  await t.destroy();
});

const run = (name: string, input: unknown, caller: Caller = ownerCaller("ui")) =>
  t.kernel.execute(name, input, caller);
async function ok<T>(name: string, input: unknown, caller?: Caller): Promise<T> {
  const res = await run(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result as T;
}
async function refusal(name: string, input: unknown, caller?: Caller) {
  const res = await run(name, input, caller);
  if (res.status !== "error") throw new Error(`${name} ran: ${JSON.stringify(res)}`);
  return res;
}
const connect = (over: Record<string, string> = {}) =>
  ok<{ id: string; keyKind: string; production: boolean }>("data.connect", {
    label: "Shop",
    address: convex.address,
    key: convex.key,
    ...over,
  });
const jarvis = jarvisCaller("owner");

describe("connecting a Convex deployment", () => {
  it("keeps its key sealed, out of the audit log, and tells Jarvis only where it is", async () => {
    const { id, keyKind } = await connect({ address: `${convex.address}/` });
    expect(keyKind).toBe("development deploy key");
    const [row] = await t.tdb.db.select().from(dataSource);
    expect(row).toMatchObject({ id, label: "Shop", kind: "convex", mode: "read" });
    expect(row?.address).toBe(convex.address);
    expect(row?.secret).not.toContain("happy-otter");
    const [logged] = await t.tdb.db.select().from(audit).where(eq(audit.action, "data.connect"));
    expect(JSON.stringify(logged?.input)).not.toContain("eyJ0");
    expect(await ok("data.sources", {}, jarvis)).toEqual([
      { id, label: "Shop", kind: "convex", address: convex.address, mode: "read" },
    ]);
    const [status] = await ok<Record<string, unknown>[]>("data.status", {});
    expect(status).not.toHaveProperty("secret");
    expect(status).toMatchObject({ keyKind: "development deploy key", lastError: null });
  });

  it.each([
    [{ address: "http://happy-otter-123.convex.cloud" }, /needs https/],
    [{ address: "https://happy-otter-123.convex.site" }, /HTTP actions URL/],
    [{ address: "https://happy-otter-123.convex.cloud/api" }, /nothing after its name/],
    [
      { key: "prod:other-fox-9|eyJ0ZXN0IjoidHJ1ZSJ9" },
      /for the deployment other-fox-9, not happy-otter-123/,
    ],
    [{ key: "dev:happy-otter-123|wrong-key-0123" }, /doesn't accept this key/],
  ])("refuses %j", async (over, why) => {
    expect(
      (
        await refusal("data.connect", {
          label: "Shop",
          address: convex.address,
          key: convex.key,
          ...over,
        })
      ).message,
    ).toMatch(why);
    expect(await t.tdb.db.select().from(dataSource)).toEqual([]);
  });

  it("won't take a second source by the same name", async () => {
    await connect();
    expect(
      (await refusal("data.connect", { label: "Shop", address: convex.address, key: convex.key }))
        .message,
    ).toMatch(/already a source named Shop/);
  });

  it("is for you alone: Jarvis can't connect one or see what's wrong with it", async () => {
    const input = { label: "Shop", address: convex.address, key: convex.key };
    expect((await run("data.connect", input, jarvis)).status).toBe("denied");
    expect((await run("data.status", {}, jarvis)).status).toBe("denied");
    expect((await run("data.disconnect", { source: crypto.randomUUID() }, jarvis)).status).toBe(
      "denied",
    );
    // What comes back is outside content: the rest of Jarvis's turn is untrusted (D25).
    for (const name of ["data.tables", "data.documents", "data.functions", "data.query"])
      expect(dataModule.actions.find((a) => a.name === name)).toMatchObject({
        risk: "read",
        external: true,
      });
  });

  it("checks a key again, and says when it stopped working", async () => {
    const { id } = await connect();
    convex.key = "dev:happy-otter-123|rotated-key-0123";
    expect(await ok("data.check", { source: id })).toEqual({
      ok: false,
      problem: "Convex doesn't accept this key for that deployment.",
    });
    const [row] = await t.tdb.db.select().from(dataSource);
    expect(row?.lastError).toMatch(/doesn't accept this key/);
    await ok("data.disconnect", { source: id });
    expect(await t.tdb.db.select().from(dataSource)).toEqual([]);
  });
});

describe("reading a Convex deployment", () => {
  it("lists its tables, with the shape its schema declares", async () => {
    const { id } = await connect();
    const r = await ok<{ tables: unknown[]; outside: boolean }>(
      "data.tables",
      { source: id },
      jarvis,
    );
    expect(r.tables).toEqual([
      {
        name: "orders",
        shape: { type: "object", value: { customer: { fieldType: { type: "string" } } } },
      },
      { name: "events", shape: null },
    ]);
    expect(r.outside).toBe(true);
  });

  it("takes each table's shape from the streaming export, where the deployment has one", async () => {
    convex.exported = { orders: { type: "object", properties: { customer: { type: "string" } } } };
    const { id } = await connect();
    convex.calls = [];
    const r = await ok<{ tables: unknown[] }>("data.tables", { source: id }, jarvis);
    expect(r.tables).toEqual([
      { name: "orders", shape: { type: "object", properties: { customer: { type: "string" } } } },
    ]);
    // None of the system functions: the export told it all.
    expect(convex.calls).toEqual([]);
  });

  it("pages through a table's documents, newest first, with long values cut", async () => {
    const { id } = await connect();
    type Docs = { documents: { _id: string; note: string }[]; cursor: string | null };
    const first = await ok<Docs>(
      "data.documents",
      { source: id, table: "orders", limit: 20 },
      jarvis,
    );
    expect(first.documents.map((d) => d._id).slice(0, 2)).toEqual(["o30", "o29"]);
    expect(first.documents[0]?.note).toHaveLength(2_001);
    const rest = await ok<Docs>(
      "data.documents",
      { source: id, table: "orders", limit: 20, cursor: first.cursor },
      jarvis,
    );
    expect(rest.documents.map((d) => d._id).at(-1)).toBe("o1");
    expect(rest.cursor).toBeNull();
    expect(
      (await refusal("data.documents", { source: id, table: "orders", limit: 500 }, jarvis)).code,
    ).toBe("invalid_input");
  });

  it("stops a page that's too big, with no cursor past what it didn't show", async () => {
    const { id } = await connect();
    limits.bytes = 5_000;
    const r = await ok<{ documents: unknown[]; cursor: string | null; note: string }>(
      "data.documents",
      { source: id, table: "orders", limit: 10 },
      jarvis,
    );
    expect(r.documents).toHaveLength(2);
    expect(r.cursor).toBeNull();
    expect(r.note).toMatch(/Only 2 fit/);
  });

  it("lists the deployment's queries and runs one with its args", async () => {
    convex.functions = [
      {
        identifier: "orders.js:byCustomer",
        functionType: "Query",
        visibility: { kind: "public" },
        args: '{"type":"object"}',
      },
      { identifier: "orders.js:refund", functionType: "Mutation", visibility: { kind: "public" } },
      {
        identifier: "admin/stats.js:totals",
        functionType: "Query",
        visibility: { kind: "internal" },
      },
      { identifier: "http.js:default", functionType: "HttpAction" },
    ];
    convex.queries.set("orders:byCustomer", (args) => ({ customer: args.customer, orders: 3 }));
    const { id } = await connect();
    const fns = await ok<{ functions: unknown[] }>("data.functions", { source: id }, jarvis);
    expect(fns.functions).toEqual([
      // The mutation isn't listed: this source is read-only.
      { path: "orders:byCustomer", type: "query", visibility: "public", args: { type: "object" } },
      { path: "admin/stats:totals", type: "query", visibility: "internal", args: undefined },
    ]);
    const r = await ok<{ value: unknown }>(
      "data.query",
      { source: id, path: "orders:byCustomer", args: { customer: "Ana" } },
      jarvis,
    );
    expect(r.value).toEqual({ customer: "Ana", orders: 3 });
  });

  it("runs none of Convex's own functions, and passes on what Convex says went wrong", async () => {
    const { id } = await connect();
    for (const path of ["_system/cli/tableData", "_system/frontend/getSchemas", "../x:y", "a b"])
      expect((await refusal("data.query", { source: id, path }, jarvis)).code).toBe(
        "invalid_input",
      );
    convex.queries.set("orders:broken", () => {
      throw new ConvexError("failed", "Uncaught Error: no such customer");
    });
    const failed = await refusal("data.query", { source: id, path: "orders:broken" }, jarvis);
    expect(failed).toMatchObject({ code: "failed", message: "Uncaught Error: no such customer" });
    convex.failWith = new ConvexError("unreachable", "Convex couldn't be reached.");
    expect((await refusal("data.tables", { source: id }, jarvis)).code).toBe("unavailable");
  });
});

describe("Convex's addresses and keys", () => {
  it("tells a key's kind, and the deployment it names", () => {
    expect(describeKey("prod:happy-otter-123|abc")).toEqual({
      kind: "production deploy key",
      production: true,
      deployment: "happy-otter-123",
    });
    expect(describeKey("preview:team:project|abc")).toMatchObject({
      kind: "preview deploy key",
      deployment: null,
    });
    expect(describeKey("convex-self-hosted|abc")).toMatchObject({
      kind: "admin key",
      production: false,
    });
  });

  it("takes https anywhere and plain http only on this PC", () => {
    expect(deploymentAddress(" https://happy-otter-123.convex.cloud/ ")).toBe(
      "https://happy-otter-123.convex.cloud",
    );
    expect(deploymentAddress("http://127.0.0.1:3210")).toBe("http://127.0.0.1:3210");
    expect(() => deploymentAddress("http://10.0.0.5:3210")).toThrow(/needs https/);
    expect(() => deploymentAddress("https://user:pw@x.convex.cloud")).toThrow(
      /nothing after its name/,
    );
  });
});
