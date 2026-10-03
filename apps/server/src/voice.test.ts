import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownerCaller } from "@hearth/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pairDevice } from "./auth/devices.ts";
import { createTestServer, type TestServer } from "./testing/server.ts";

let t: TestServer;
let dir: string;
const before = process.env.HEARTH_DATA_DIR;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hearth-voice-"));
  process.env.HEARTH_DATA_DIR = dir;
  t = await createTestServer({ devAuth: true });
});
afterEach(async () => {
  await t.destroy();
  process.env.HEARTH_DATA_DIR = before;
  await rm(dir, { recursive: true, force: true });
});

const wav = () => {
  const b = new Uint8Array(64);
  b.set(new TextEncoder().encode("RIFF"), 0);
  b.set(new TextEncoder().encode("WAVE"), 8);
  return b;
};

describe("voice samples", () => {
  it("keeps a recording with what was said, and your vocabulary beside them", async () => {
    await t.kernel.execute(
      "dictionary.add",
      { heard: "auto pair", write: "OtoPair" },
      ownerCaller(),
    );
    const put = (name: string, body: Uint8Array, said = "Open OtoPair, please.") =>
      t.browser(`/api/voice/samples/${name}`, {
        method: "PUT",
        headers: { "x-said": encodeURIComponent(said) },
        body,
      });
    expect((await put("dictation-01", wav())).status).toBe(200);
    const folder = join(dir, "voice-samples");
    expect(await readFile(join(folder, "dictation-01.txt"), "utf8")).toBe(
      "Open OtoPair, please.\n",
    );
    expect(await readFile(join(folder, "vocabulary.txt"), "utf8")).toContain("OtoPair");
    expect(await (await t.browser("/api/voice/samples")).json()).toMatchObject({
      names: ["dictation-01"],
    });

    expect((await put("../evil", wav())).status).toBe(404);
    expect(
      (await put("dictation-02", new TextEncoder().encode("not a wav file at all, nope"))).status,
    ).toBe(400);
    expect((await put("dictation-02", wav(), "")).status).toBe(400);
    const badHeader = await t.browser("/api/voice/samples/dictation-02", {
      method: "PUT",
      headers: { "x-said": "%E0%A4%A" },
      body: wav(),
    });
    expect(badHeader.status).toBe(400);
    expect((await put("dictation-02", new Uint8Array(11 * 1024 * 1024))).status).toBe(413);

    expect((await t.browser("/api/voice/samples/dictation-01", { method: "DELETE" })).status).toBe(
      200,
    );
    expect(await (await t.browser("/api/voice/samples")).json()).toMatchObject({ names: [] });
  });

  it("is off limits to the desktop app's code", async () => {
    const token = await pairDevice(t.kernel.db, "desktop");
    expect((await t.api("/api/voice/samples", token)).status).toBe(403);
  });
});
