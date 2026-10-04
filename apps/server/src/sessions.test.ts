// Sign-ins that last while you use them (D56): the expiry slides, "last seen" is written at most
// every few minutes, the live feed ends with the session, and stale passkey challenges are cleared.
import { PRINCIPAL } from "@hearth/core";
import { authChallenge, createSession, session } from "@hearth/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticate } from "./auth/middleware.ts";
import { registrationOptions, relyingParty } from "./auth/passkeys.ts";
import { checkToken, hashToken, revokeToken } from "./auth/tokens.ts";
import type { AppEnv, ServerDeps } from "./env.ts";
import { eventRoutes } from "./routes/events.ts";
import { createTestServer, TEST_ORIGIN, type TestServer } from "./testing/server.ts";

const MIN = 60_000;
const DAY = 86_400_000;
const T0 = new Date("2026-10-01T09:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer();
});
afterEach(async () => {
  vi.useRealTimers();
  await t.destroy();
});

async function row(token: string) {
  const [r] = await t.kernel.db
    .select()
    .from(session)
    .where(eq(session.tokenHash, hashToken(token)));
  return r!;
}

const browserSession = () =>
  createSession(t.kernel.db, { principal: PRINCIPAL.owner, kind: "browser", ttlDays: 30 }, T0);

describe("sliding sign-ins", () => {
  it("keeps a sign-in you use alive, and lets one you don't run out", async () => {
    const token = await browserSession();
    // Day 29: still in, and using it moves the end to 30 days from now.
    const used = await checkToken(t.kernel.db, token, at(29 * DAY));
    expect(used).toMatchObject({ ok: true, extendedUntil: at(59 * DAY) });
    expect((await row(token)).expiresAt).toEqual(at(59 * DAY));
    // Day 45: without that use it would have ended on day 30.
    expect((await checkToken(t.kernel.db, token, at(45 * DAY))).ok).toBe(true);
    // Untouched for over 30 days after that: it's over.
    expect(await checkToken(t.kernel.db, token, at(76 * DAY))).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("writes 'last seen' at most every five minutes", async () => {
    const token = await browserSession();
    expect((await checkToken(t.kernel.db, token, at(MIN))).ok).toBe(true);
    expect((await row(token)).lastSeenAt).toEqual(at(MIN));
    // A minute later: nothing written, nothing to renew.
    const soon = await checkToken(t.kernel.db, token, at(2 * MIN));
    expect(soon).toMatchObject({ ok: true, extendedUntil: null });
    expect((await row(token)).lastSeenAt).toEqual(at(MIN));
    // Five minutes on, it's written again.
    await checkToken(t.kernel.db, token, at(6 * MIN));
    expect((await row(token)).lastSeenAt).toEqual(at(6 * MIN));
    // A check that isn't a use (the live feed's) writes nothing.
    await checkToken(t.kernel.db, token, at(20 * MIN), { touch: false });
    expect((await row(token)).lastSeenAt).toEqual(at(6 * MIN));
  });

  it("only slides browser sign-ins; tokens keep the life they were given", async () => {
    const forever = await createSession(t.kernel.db, { principal: PRINCIPAL.jarvis, kind: "api" });
    const internal = await createSession(
      t.kernel.db,
      { principal: PRINCIPAL.jarvis, kind: "api", ttlDays: 1 },
      T0,
    );
    await checkToken(t.kernel.db, forever, at(10 * MIN));
    expect((await row(forever)).expiresAt).toBeNull();
    expect((await row(forever)).lastSeenAt).toEqual(at(10 * MIN));
    const r = await checkToken(t.kernel.db, internal, at(10 * MIN));
    expect(r).toMatchObject({ ok: true, extendedUntil: null });
    expect((await row(internal)).expiresAt).toEqual(at(DAY));
  });

  it("keeps you signed in when 'last seen' can't be written, and logs it without the token", async () => {
    const token = await browserSession();
    const hash = hashToken(token);
    // The shape Drizzle gives a failed write: the query's values, the token's hash among them.
    const failing = new Proxy(t.kernel.db, {
      get: (db, prop) =>
        prop === "update"
          ? () => {
              throw new Error(`Failed query: update "session" set ...\nparams: ${hash}`);
            }
          : Reflect.get(db, prop),
    });
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line) => logged.push(String(line)));
    const r = await checkToken(failing, token, at(MIN));
    spy.mockRestore();
    expect(r).toMatchObject({ ok: true, extendedUntil: null });
    expect(logged.join("\n")).toContain("couldn't record a session's use");
    expect(logged.join("\n")).not.toContain(hash);
  });

  it("says why a token is refused", async () => {
    const token = await browserSession();
    expect(await checkToken(t.kernel.db, "nope", at(MIN))).toEqual({
      ok: false,
      reason: "unknown",
    });
    await revokeToken(t.kernel.db, token, at(MIN));
    expect(await checkToken(t.kernel.db, token, at(2 * MIN))).toEqual({
      ok: false,
      reason: "revoked",
    });
  });

  it("sends a fresh cookie when a sign-in slides, and not on every request", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const token = await browserSession();
    t.cookies.set("hearth_session", token);
    vi.setSystemTime(at(10 * DAY));
    const first = await t.browser("/api/auth/me");
    expect(await first.json()).toMatchObject({ signedIn: true });
    const cookie = first.headers.getSetCookie().find((c) => c.startsWith("hearth_session="));
    expect(cookie).toMatch(/Max-Age=2592000/);
    expect(cookie).toMatch(/HttpOnly/);
    vi.setSystemTime(at(10 * DAY + MIN));
    const next = await t.browser("/api/auth/me");
    expect(next.headers.getSetCookie().some((c) => c.startsWith("hearth_session="))).toBe(false);
  });

  it("doesn't count the page's update check as a use, so an open tab alone runs out", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const token = await browserSession();
    t.cookies.set("hearth_session", token);
    // The update notice asks every five minutes (D57): here, a few times over a day and a half.
    for (let ms = 10 * DAY; ms <= 11.5 * DAY; ms += 6 * 60 * MIN) {
      vi.setSystemTime(at(ms));
      const res = await t.browser("/api/health/deep");
      expect(res.status).toBe(200);
      expect(res.headers.getSetCookie()).toEqual([]);
    }
    expect(await row(token)).toMatchObject({ lastSeenAt: null, expiresAt: at(30 * DAY) });
    // Anything you do still counts.
    await t.browser("/api/auth/me");
    expect((await row(token)).expiresAt).toEqual(at(11.5 * DAY + 30 * DAY));
  });
});

describe("the live feed and the session behind it", () => {
  it("ends the feed once the session is signed out", async () => {
    const deps: ServerDeps = {
      kernel: t.kernel,
      pool: null as never,
      config: { ...({} as ServerDeps["config"]), origin: TEST_ORIGIN, devAuth: false },
      hub: t.server.hub,
    };
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("deps", deps);
      await next();
    });
    app.use("*", authenticate());
    app.route("/events", eventRoutes(50));
    const token = await createSession(t.kernel.db, {
      principal: PRINCIPAL.owner,
      kind: "browser",
      ttlDays: 30,
    });
    const res = await app.request("/events", { headers: { cookie: `hearth_session=${token}` } });
    expect(res.status).toBe(200);
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let seen = "";
    while (!seen.includes("event: ping")) seen += (await reader.read()).value ?? "";
    expect(seen).toContain("retry: 2000");
    await revokeToken(t.kernel.db, token);
    for (;;) if ((await reader.read()).done) break;
  });
});

describe("passkey challenges", () => {
  it("clears abandoned ones as new ones are made", async () => {
    await t.kernel.db.insert(authChallenge).values({
      id: "old",
      challenge: "x",
      purpose: "login",
      createdAt: new Date(Date.now() - 60 * MIN),
      expiresAt: new Date(Date.now() - 55 * MIN),
    });
    await registrationOptions(t.kernel.db, relyingParty(TEST_ORIGIN));
    const left = await t.kernel.db.select({ id: authChallenge.id }).from(authChallenge);
    expect(left.map((r) => r.id)).not.toContain("old");
    expect(left).toHaveLength(1);
  });
});
