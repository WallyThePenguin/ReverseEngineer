import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Caller, jarvisCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL_MODULES } from "../index.ts";
import { BLOB_SERVICE, BlobStore } from "../mail/blobs.ts";
import { fileMime } from "./index.ts";

let t: TestKernel;
let dir: string;
let blobs: BlobStore;
beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  dir = await mkdtemp(join(tmpdir(), "hearth-files-"));
  blobs = new BlobStore(dir);
  t.kernel.services[BLOB_SERVICE] = blobs;
});
afterEach(async () => {
  await t.destroy();
  await rm(dir, { recursive: true, force: true });
});

const run = (name: string, input: unknown, caller: Caller = ownerCaller()) =>
  t.kernel.execute<{ id: string }>(name, input, caller);

describe("what a file is", () => {
  const bytes = (...b: number[]) => new Uint8Array([...b, 0, 0, 0, 0, 0, 0, 0, 0]);
  it("is an image Hearth shows only when its bytes say so", () => {
    expect(fileMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), "")).toBe("image/png");
    expect(fileMime(bytes(0xff, 0xd8, 0xff), "image/png")).toBe("image/jpeg");
    expect(fileMime(new TextEncoder().encode("GIF89a"), undefined)).toBe("image/gif");
    const webp = new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ");
    expect(fileMime(webp, "application/octet-stream")).toBe("image/webp");
    // A page saved as a picture, and a picture that's a page.
    expect(fileMime(new TextEncoder().encode("<html>"), "image/png")).toBe(
      "application/octet-stream",
    );
    expect(fileMime(new TextEncoder().encode("<svg>"), "image/svg+xml")).toBe("image/svg+xml");
  });

  it("is otherwise what the browser said, when that's a plain type", () => {
    expect(fileMime(bytes(1), "application/pdf")).toBe("application/pdf");
    expect(fileMime(bytes(1), "Text/Plain; charset=utf-8")).toBe("text/plain");
    expect(fileMime(bytes(1), "text/html\r\nx-evil: 1")).toBe("application/octet-stream");
    expect(fileMime(bytes(1), "")).toBe("application/octet-stream");
  });
});

describe("file records", () => {
  it("are kept only for bytes stored here, and only by you", async () => {
    const hash = await blobs.put(Buffer.from("hello"));
    const file = { hash, name: "hello.txt", mime: "text/plain", size: 5 };
    const made = await run("file.create", file);
    expect(made).toMatchObject({ status: "ok", result: { name: "hello.txt", size: 5 } });
    // Jarvis can't name bytes it found (an email's original) as a file of yours.
    expect((await run("file.create", file, jarvisCaller("owner"))).status).not.toBe("ok");
    const missing = await run("file.create", { ...file, hash: "ab".repeat(32) });
    expect(missing).toMatchObject({ status: "error", code: "not_found" });

    // Jarvis reads one like any record, and it's gone once trashed.
    const id = made.status === "ok" ? made.result.id : "";
    const read = t.kernel.registry.describer("file")!;
    expect(await read(id, { db: t.tdb.db } as never)).toContain("a file: text/plain, 5 bytes");
    expect(await run("file.get", { id }, jarvisCaller("owner"))).toMatchObject({ status: "ok" });
    await run("entity.trash", { id });
    expect(await run("file.get", { id })).toMatchObject({ status: "error", code: "not_found" });
  });
});
