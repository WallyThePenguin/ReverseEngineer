// The web app's files: compressed copies when the browser takes them, built files cached for
// good, and the page and service worker checked every time.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestServer, type TestServer } from "./testing/server.ts";

const SCRIPT = `console.log(${JSON.stringify("hello ".repeat(400))});`;
let dist: string;
let t: TestServer;

beforeAll(async () => {
  dist = mkdtempSync(join(tmpdir(), "hearth-dist-"));
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "index.html"), '<script src="/assets/index-abc123.js"></script>');
  writeFileSync(join(dist, "sw.js"), "self.addEventListener('fetch', () => {});");
  const js = join(dist, "assets", "index-abc123.js");
  writeFileSync(js, SCRIPT);
  writeFileSync(`${js}.br`, brotliCompressSync(SCRIPT));
  writeFileSync(`${js}.gz`, gzipSync(SCRIPT));
  writeFileSync(join(dist, "assets", "loro-abc.wasm"), Buffer.from([0, 97, 115, 109]));
  t = await createTestServer({ webDist: dist });
});
afterAll(async () => {
  await t.destroy();
  rmSync(dist, { recursive: true, force: true });
});

const get = (path: string, encoding = "br, gzip") =>
  t.server.app.request(path, { headers: { "accept-encoding": encoding } });

describe("the web app's files", () => {
  it("sends a built file compressed, and lets the browser keep it for good", async () => {
    const res = await get("/assets/index-abc123.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("br");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("vary")).toContain("Accept-Encoding");
    expect(Number(res.headers.get("content-length"))).toBeLessThan(SCRIPT.length);
    expect((await get("/assets/index-abc123.js", "gzip")).headers.get("content-encoding")).toBe(
      "gzip",
    );
    const plain = await get("/assets/index-abc123.js", "identity");
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(await plain.text()).toBe(SCRIPT);
  });

  it("serves WebAssembly as such, so it compiles while it downloads", async () => {
    const res = await get("/assets/loro-abc.wasm");
    expect(res.headers.get("content-type")).toBe("application/wasm");
  });

  it("checks the page and the service worker every time", async () => {
    for (const path of ["/", "/notes/abc", "/sw.js"]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-cache");
    }
  });

  it("answers a missing built file with a 404, not the app", async () => {
    const res = await get("/assets/index-old999.js");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).not.toContain("<script");
  });
});
