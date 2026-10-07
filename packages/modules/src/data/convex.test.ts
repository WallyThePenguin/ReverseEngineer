// The Convex client against a local stand-in for a deployment's HTTP API: what it sends, and
// what it makes of each kind of answer.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { httpConvex, LIMITS } from "./convex.ts";

let server: Server;
let address = "";
const seen: { url?: string; auth?: string; body: unknown }[] = [];
const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void>();
const answer = (status: number, body: unknown) => (_: IncomingMessage, res: ServerResponse) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      seen.push({
        url: req.url,
        auth: req.headers.authorization,
        body: raw ? JSON.parse(raw) : null,
      });
      const path = (JSON.parse(raw || "{}") as { path?: string }).path ?? req.url ?? "";
      (routes.get(path) ?? answer(404, {}))(req, res);
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  return new Promise<void>((done) => server.close(() => done()));
});

const api = httpConvex({ ...LIMITS, timeoutMs: 500, responseBytes: 10_000 });
const query = (path: string) => api.query(address, "dev:x|key", path, { customer: "Ana" });

describe("httpConvex", () => {
  it("posts the query as JSON with the key as admin, and gives back its value", async () => {
    routes.set("orders:list", answer(200, { status: "success", value: [{ n: 1 }], logLines: [] }));
    expect(await query("orders:list")).toEqual([{ n: 1 }]);
    expect(seen.at(-1)).toEqual({
      url: "/api/query",
      auth: "Convex dev:x|key",
      body: { path: "orders:list", args: { customer: "Ana" }, format: "json" },
    });
  });

  it("says what the function said when it failed, and what Convex said of the key", async () => {
    routes.set(
      "orders:broken",
      answer(400, { status: "error", errorMessage: "Uncaught Error: nope" }),
    );
    await expect(query("orders:broken")).rejects.toMatchObject({
      kind: "failed",
      message: "Uncaught Error: nope",
    });
    routes.set("orders:locked", answer(401, { code: "BadAdminKey", message: "bad key" }));
    await expect(query("orders:locked")).rejects.toMatchObject({ kind: "refused" });
    routes.set("orders:down", answer(503, {}));
    await expect(query("orders:down")).rejects.toMatchObject({ kind: "unreachable" });
  });

  it("refuses an answer past its cap, and one that doesn't come in time", async () => {
    routes.set("orders:huge", answer(200, { status: "success", value: "x".repeat(20_000) }));
    await expect(query("orders:huge")).rejects.toMatchObject({ kind: "too_big" });
    routes.set("orders:slow", () => {});
    await expect(query("orders:slow")).rejects.toMatchObject({
      kind: "unreachable",
      message: "Convex took longer than 0.5 seconds.",
    });
  });

  it("reads the streaming export's shapes, and none where the deployment hasn't one", async () => {
    const shapes = { orders: { type: "object" } };
    routes.set("/api/json_schemas?format=json", answer(200, shapes));
    expect(await api.shapes(address, "dev:x|key")).toEqual(shapes);
    expect(seen.at(-1)).toMatchObject({
      url: "/api/json_schemas?format=json",
      auth: "Convex dev:x|key",
    });
    routes.set("/api/json_schemas?format=json", answer(400, { code: "StreamingExportNotEnabled" }));
    expect(await api.shapes(address, "dev:x|key")).toBeNull();
  });

  it("doesn't follow a redirect, so the key goes nowhere else", async () => {
    routes.set("orders:moved", (_, res) => {
      res.writeHead(307, { location: `${address}/elsewhere` });
      res.end();
    });
    const before = seen.length;
    await expect(query("orders:moved")).rejects.toMatchObject({ kind: "unreachable" });
    expect(seen.slice(before).map((s) => s.url)).toEqual(["/api/query"]);
  });
});
