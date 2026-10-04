// system.status: what's set up so far, for the "Set up Hearth" checklist.
import { googleAccount, pushSubscription, session } from "@hearth/db";
import { ownerCaller, setSetting } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL_MODULES } from "../index.ts";

let t: TestKernel;
beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
});
afterEach(() => t.destroy());

async function ok<T>(name: string, input: unknown): Promise<T> {
  const res = await t.kernel.execute<T>(name, input, ownerCaller("ui"));
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const setup = async () =>
  (await ok<{ setup: Record<string, boolean> }>("system.status", {})).setup;

describe("system.status setup", () => {
  it("starts with nothing connected", async () => {
    expect(await setup()).toEqual({ google: false, chrome: false, phone: false, desktop: false });
  });

  it("sees Google, Chrome, a phone and the desktop app once they're connected", async () => {
    const db = t.tdb.db;
    await db.insert(googleAccount).values({ email: "me@example.com", refreshToken: "x" });
    await setSetting(db, "browser.pairing", { hash: "h", createdAt: new Date().toISOString() });
    await db
      .insert(pushSubscription)
      .values({ endpoint: "https://push.example/1", p256dh: "k", auth: "a", label: "Phone" });
    await db.insert(session).values({
      tokenHash: "t1",
      principal: "owner",
      kind: "api",
      label: "device:desktop",
      scopes: ["voice.clean"],
    });
    expect(await setup()).toEqual({ google: true, chrome: true, phone: true, desktop: true });
  });

  it("doesn't count a revoked Google account or an unpaired device", async () => {
    const db = t.tdb.db;
    await db
      .insert(googleAccount)
      .values({ email: "me@example.com", refreshToken: "x", status: "revoked" });
    await db.insert(session).values({
      tokenHash: "t2",
      principal: "owner",
      kind: "api",
      label: "device:desktop",
      revokedAt: new Date(),
    });
    // A passkey sign-in isn't a paired device.
    await db.insert(session).values({ tokenHash: "t3", principal: "owner", kind: "browser" });
    const s = await setup();
    expect(s.google).toBe(false);
    expect(s.desktop).toBe(false);
  });
});
