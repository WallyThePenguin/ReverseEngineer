import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listDevices, pairDevice, revokeDevice } from "./auth/devices.ts";
import { createTestServer, type TestServer } from "./testing/server.ts";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer();
});
afterEach(() => t.destroy());

describe("device tokens", () => {
  it("lets the desktop app run only its own actions", async () => {
    const token = await pairDevice(t.kernel.db, "desktop");
    const clean = await t.api("/api/actions/voice.clean", token, {
      method: "POST",
      json: { raw: "um hello there", save: false },
    });
    expect(clean.status).toBe(200);
    expect(await clean.json()).toMatchObject({ result: { text: "Hello there" } });

    for (const [path, method] of [
      ["/api/actions/task.list", "POST"],
      ["/api/actions/entity.restore", "POST"],
      ["/api/actions", "GET"],
      ["/api/devices/desktop/pair", "POST"],
      ["/api/events", "GET"],
      ["/mcp", "POST"],
    ] as const) {
      const res = await t.api(path, token, { method, ...(method === "POST" ? { json: {} } : {}) });
      expect([path, res.status]).toEqual([path, 403]);
    }
  });

  it("pairing again signs out the old code, and unpairing signs out the new one", async () => {
    const first = await pairDevice(t.kernel.db, "desktop");
    const second = await pairDevice(t.kernel.db, "desktop");
    const styles = (token: string) =>
      t.api("/api/actions/voice.styles", token, { method: "POST", json: {} });
    expect((await styles(first)).status).toBe(401);
    expect((await styles(second)).status).toBe(200);
    expect(await listDevices(t.kernel.db)).toMatchObject([{ name: "desktop" }]);
    expect(await revokeDevice(t.kernel.db, "desktop")).toBe(1);
    expect((await styles(second)).status).toBe(401);
    expect(await listDevices(t.kernel.db)).toEqual([]);
    await expect(pairDevice(t.kernel.db, "toaster")).rejects.toThrow();
  });
});
