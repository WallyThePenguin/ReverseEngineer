import { event } from "@hearth/db";
import { ownerCaller } from "@hearth/kernel";
import { eq } from "drizzle-orm";
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

  it("talks to Jarvis as outside content, and sees only its own conversations", async () => {
    const token = await pairDevice(t.kernel.db, "desktop");
    const post = (name: string, json: unknown) =>
      t.api(`/api/actions/${name}`, token, { method: "POST", json });
    const sent = await post("chat.send", { text: "what's on today" });
    expect(sent.status).toBe(200);
    const { result } = (await sent.json()) as { result: { conversationId: string; idx: number } };
    const [posted] = await t.kernel.db
      .select()
      .from(event)
      .where(eq(event.kind, "chat.message_posted"));
    expect(posted?.origin).toBe("untrusted");
    expect((await post("conversation.get", { id: result.conversationId })).status).toBe(200);

    const mine = await t.kernel.execute<{ conversationId: string }>(
      "chat.send",
      { text: "private" },
      ownerCaller(),
    );
    if (mine.status !== "ok") throw new Error("chat.send failed");
    const id = mine.result.conversationId;
    expect((await post("conversation.get", { id })).status).toBe(404);
    expect((await post("chat.send", { conversationId: id, text: "hi" })).status).toBe(404);
  });
});
