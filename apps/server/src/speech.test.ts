import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pairDevice } from "./auth/devices.ts";
import { SpeechRelay } from "./speech.ts";
import { createTestServer, type TestServer } from "./testing/server.ts";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ devAuth: true });
});
afterEach(() => t.destroy());

const wav = () => {
  const b = new Uint8Array(64);
  b.set(new TextEncoder().encode("RIFF"), 0);
  b.set(new TextEncoder().encode("WAVE"), 8);
  return b;
};

describe("speech through the desktop app", () => {
  it("hands a recording to the desktop app and returns its text", async () => {
    const token = await pairDevice(t.kernel.db, "desktop");
    // Nobody to transcribe yet.
    const early = await t.browser("/api/voice/transcribe", { method: "POST", body: wav() });
    expect(early.status).toBe(503);

    const desktop = (async () => {
      const job = await t.api("/api/voice/jobs/next", token);
      expect(job.status).toBe(200);
      expect(new Uint8Array(await job.arrayBuffer())).toEqual(wav());
      const id = job.headers.get("x-job-id")!;
      const done = await t.api(`/api/voice/jobs/${id}`, token, {
        method: "POST",
        json: { text: "Remind me to call Sam." },
      });
      expect(done.status).toBe(200);
    })();
    // Let the desktop app's request arrive first.
    await new Promise((r) => setTimeout(r, 50));
    const res = await t.browser("/api/voice/transcribe", { method: "POST", body: wav() });
    expect(await res.json()).toEqual({ text: "Remind me to call Sam." });
    await desktop;
  });

  it("holds only a few recordings at once", async () => {
    const relay = new SpeechRelay();
    const waiting = Array.from({ length: 4 }, () => relay.transcribe(wav(), 30).catch(() => null));
    expect(relay.busy()).toBe(true);
    await Promise.all(waiting);
    expect(relay.busy()).toBe(false);
  });

  it("keeps each side to its own half", async () => {
    const token = await pairDevice(t.kernel.db, "desktop");
    expect(
      (await t.api("/api/voice/transcribe", token, { method: "POST", body: wav() })).status,
    ).toBe(403);
    expect((await t.browser("/api/voice/jobs/next")).status).toBe(403);
    expect((await t.api("/api/voice/jobs/../samples", token)).status).toBe(403);
    expect(
      (
        await t.api("/api/voice/jobs/0b9d8f3e-1c2a-4e5f-9a7b-123456789abc", token, {
          method: "POST",
          json: { text: "x" },
        })
      ).status,
    ).toBe(404);
  });
});
