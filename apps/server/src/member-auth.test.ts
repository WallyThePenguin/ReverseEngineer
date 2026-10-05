// A Slack member is only ever a turn the worker starts: they never get a session or a token,
// whatever is in the database (D62).
import { memberPrincipal } from "@hearth/core";
import { createSession, principal } from "@hearth/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkToken, checkTokenFast, createApiToken } from "./auth/tokens.ts";
import { createTestServer, type TestServer } from "./testing/server.ts";

const SAM = memberPrincipal("T1", "U_SAM");

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer();
  await t.kernel.db.insert(principal).values({ id: SAM, kind: "member", displayName: "Sam Lee" });
});
afterEach(() => t.destroy());

describe("a Slack member", () => {
  it("can't use a session, even one that somehow exists", async () => {
    const api = await createSession(t.kernel.db, { principal: SAM, kind: "api" });
    const browser = await createSession(t.kernel.db, {
      principal: SAM,
      kind: "browser",
      ttlDays: 30,
    });
    for (const token of [api, browser]) {
      expect(await checkToken(t.kernel.db, token)).toEqual({ ok: false, reason: "disabled" });
      expect(await checkTokenFast(t.kernel.db, token)).toEqual({ ok: false, reason: "disabled" });
    }
    const res = await t.api("/api/actions/task.list", api, { method: "POST", json: {} });
    expect(res.status).toBe(401);
  });

  it("is never given a token by hearth token create", async () => {
    // Only an outside agent's principal can be, so one of any other kind under that id is
    // refused and left as it was.
    await t.kernel.db
      .insert(principal)
      .values({ id: "mcp:sam", kind: "member", displayName: "Sam", disabledAt: new Date() });
    await expect(createApiToken(t.kernel.db, "sam")).rejects.toThrow(/isn't an outside agent/);
    const [row] = await t.kernel.db.select().from(principal).where(eq(principal.id, "mcp:sam"));
    expect(row).toMatchObject({ kind: "member" });
    expect(row?.disabledAt).not.toBeNull();
    // An outside agent's still is.
    expect((await createApiToken(t.kernel.db, "laptop")).principal).toBe("mcp:laptop");
  });
});
