// Adding files and reading them back (/api/files): only you add them; a PNG, JPEG, GIF or WebP
// is shown in Hearth's page, and anything else, whatever it says it is, is only downloaded.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRINCIPAL } from "@hearth/core";
import { createSession } from "@hearth/db";
import { ownerCaller } from "@hearth/kernel";
import { BLOB_SERVICE, BlobStore } from "@hearth/modules";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiToken } from "./auth/tokens.ts";
import { createTestServer, type TestServer } from "./testing/server.ts";

let t: TestServer;
let dir: string;

beforeEach(async () => {
  t = await createTestServer({ devAuth: true });
  dir = await mkdtemp(join(tmpdir(), "hearth-files-"));
  t.kernel.services[BLOB_SERVICE] = new BlobStore(dir);
});
afterEach(async () => {
  await t.destroy();
  await rm(dir, { recursive: true, force: true });
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

async function add(body: Uint8Array | string, name: string, type: string) {
  const res = await t.browser(`/api/files?name=${encodeURIComponent(name)}`, {
    method: "POST",
    body,
    headers: { "content-type": type },
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("files", () => {
  it("shows an image in Hearth's page, under a policy that runs nothing", async () => {
    const { status, json } = await add(PNG, "Pasted image.png", "image/png");
    expect(status).toBe(200);
    expect(json).toMatchObject({ name: "Pasted image.png", mime: "image/png", size: PNG.length });
    const res = await t.browser(`/api/files/${json.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toMatch(/^inline; filename="Pasted image.png"/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
    // Downloaded when asked.
    const down = await t.browser(`/api/files/${json.id}?download=1`);
    expect(down.headers.get("content-disposition")).toMatch(/^attachment;/);
  });

  it("only downloads anything else, whatever it says it is", async () => {
    for (const [body, name, type] of [
      ["<script>steal()</script>", "cat.png", "image/png"],
      [
        '<svg xmlns="http://www.w3.org/2000/svg"><script>steal()</script></svg>',
        "a.svg",
        "image/svg+xml",
      ],
      ["%PDF-1.7", "Lease.pdf", "application/pdf"],
    ]) {
      const { json } = await add(body!, name!, type!);
      expect(json.mime).not.toBe("image/png");
      const res = await t.browser(`/api/files/${json.id}`);
      expect(res.headers.get("content-type")).toBe("application/octet-stream");
      expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
      expect(res.headers.get("content-security-policy")).toBe("sandbox");
    }
  });

  it("keeps the same bytes once, and a trashed file's bytes for when it comes back", async () => {
    const a = (await add(PNG, "a.png", "image/png")).json;
    const b = (await add(PNG, "b.png", "image/png")).json;
    expect(a.id).not.toBe(b.id);
    // A copy the browser kept is asked about each time: still the same, nothing is sent again.
    const etag = (await t.browser(`/api/files/${a.id}`)).headers.get("etag")!;
    const asked = { headers: { "if-none-match": etag } };
    const same = await t.browser(`/api/files/${a.id}`, asked);
    expect(same.status).toBe(304);
    // Its headers replace the kept copy's: the same policy, not the page's.
    expect(same.headers.get("content-security-policy")).toBe("sandbox");
    // Trashed, it's gone at once, even where the browser kept a copy.
    await t.kernel.execute("entity.trash", { id: a.id }, ownerCaller());
    expect((await t.browser(`/api/files/${a.id}`, asked)).status).toBe(404);
    expect((await t.browser(`/api/files/${a.id}`)).status).toBe(404);
    expect((await t.browser(`/api/files/${b.id}`)).status).toBe(200);
    await t.kernel.execute("entity.restore", { id: a.id }, ownerCaller());
    expect((await t.browser(`/api/files/${a.id}`)).status).toBe(200);
  });

  it("turns away an empty file and one over 25 MB", async () => {
    expect((await add(new Uint8Array(0), "x", "text/plain")).status).toBe(400);
    const big = await add(new Uint8Array(25 * 1024 * 1024 + 1), "big.bin", "application/zip");
    expect(big.status).toBe(413);
    expect(big.json.error).toBe("That file is over 25 MB.");
  });

  it("is added only by you, and read only by whoever may read records", async () => {
    const { json } = await add(PNG, "a.png", "image/png");
    const jarvis = await createSession(t.kernel.db, { principal: PRINCIPAL.jarvis, kind: "api" });
    const post = await t.api("/api/files?name=x", jarvis, { method: "POST", body: PNG });
    expect(post.status).toBe(403);
    // An outside agent with a token reads it like the record it is (D58).
    const { token } = await createApiToken(t.kernel.db, "laptop");
    expect((await t.api(`/api/files/${json.id}`, token)).status).toBe(200);
    expect((await t.api(`/api/files/${json.id}`, "not-a-token")).status).toBe(401);
    expect((await t.browser("/api/files/not-an-id")).status).toBe(404);
  });
});
