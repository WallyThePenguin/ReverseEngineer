// Removing a passkey: it stops signing in, wherever it worked, and Hearth's own address always
// keeps one.
import { credential } from "@hearth/db";
import { eq, isNull, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "./auth/middleware.ts";
import { SoftAuthenticator } from "./testing/authenticator.ts";
import { passkeyRig, TS_NET } from "./testing/passkeys.ts";
import { createTestServer, type TestServer } from "./testing/server.ts";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ origin: TS_NET });
});
afterEach(() => t.destroy());

const { browser, window, options, me, windowSessions, connect, firstPasskey, windowPasskey } =
  passkeyRig(() => t);

/** Until this many of the test database's queries wait on a lock. */
async function waitingOnLocks(n: number) {
  for (const end = Date.now() + 10_000; Date.now() < end; ) {
    const { rows } = await t.kernel.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if (rows[0]!.n >= n) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`${n} queries never waited on a lock`);
}

describe("removing a passkey", () => {
  const list = async () =>
    (
      (await (await browser("/api/auth/passkeys")).json()) as {
        passkeys: { id: string; label: string }[];
      }
    ).passkeys;
  const remove = (id: string) =>
    browser(`/api/auth/passkeys/${encodeURIComponent(id)}`, { method: "DELETE" });
  const signIn = async (passkey: SoftAuthenticator) => {
    const opts = await options(browser("/api/auth/login/options", { method: "POST" }));
    return browser("/api/auth/login/verify", {
      method: "POST",
      json: { response: passkey.login(opts) },
    });
  };

  it("stops it signing in, and never takes the last one for Hearth's own address", async () => {
    const laptop = await firstPasskey();
    const phone = new SoftAuthenticator(TS_NET);
    const opts = await options(browser("/api/auth/register/options", { method: "POST", json: {} }));
    const added = await browser("/api/auth/register/verify", {
      method: "POST",
      json: { response: phone.register(opts), label: "Phone" },
    });
    expect(added.status).toBe(200);
    await connect();
    await windowPasskey();
    const [, ofPhone, ofWindow] = await list();

    expect((await remove(ofPhone!.id)).status).toBe(200);
    expect((await remove(ofPhone!.id)).status).toBe(404);
    expect((await remove(ofWindow!.id)).status).toBe(200);
    expect(await me()).toMatchObject({ localPasskey: false });
    // The laptop's is the last for Hearth's own address now: it stays.
    const last = await remove((await list())[0]!.id);
    expect(last.status).toBe(409);
    expect(((await last.json()) as { error: string }).error).toContain("pc.example.ts.net");
    expect((await list()).map((p) => p.label)).toEqual(["Laptop"]);

    t.cookies.delete(SESSION_COOKIE);
    expect((await remove(ofPhone!.id)).status).toBe(401);
    expect((await signIn(phone)).status).toBe(401);
    expect((await signIn(laptop)).status).toBe(200);
  });

  it("keeps one for Hearth's own address when the last two are removed at once", async () => {
    const laptop = await firstPasskey();
    const phone = new SoftAuthenticator(TS_NET);
    const opts = await options(browser("/api/auth/register/options", { method: "POST", json: {} }));
    await browser("/api/auth/register/verify", {
      method: "POST",
      json: { response: phone.register(opts), label: "Phone" },
    });
    const [ofLaptop, ofPhone] = await list();

    // Say, Remove pressed in two tabs: each alone would be allowed, since the other is left. The
    // passkeys are held until both removals wait on them, so the two truly overlap.
    let removing!: Promise<Response[]>;
    await t.kernel.db.transaction(async (tx) => {
      await tx.select().from(credential).where(isNull(credential.rpId)).for("update");
      removing = Promise.all([remove(ofLaptop!.id), remove(ofPhone!.id)]);
      await waitingOnLocks(2);
    });
    const both = await removing;
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    const left = await list();
    expect(left).toHaveLength(1);
    t.cookies.delete(SESSION_COOKIE);
    expect((await signIn(left[0]!.label === "Laptop" ? laptop : phone)).status).toBe(200);
  });

  it("stops a sign-in that was under way when it was removed", async () => {
    await firstPasskey();
    const phone = new SoftAuthenticator(TS_NET);
    const opts = await options(browser("/api/auth/register/options", { method: "POST", json: {} }));
    await browser("/api/auth/register/verify", {
      method: "POST",
      json: { response: phone.register(opts), label: "Phone" },
    });
    const [, ofPhone] = await list();
    t.cookies.delete(SESSION_COOKIE);

    // The phone's sign-in has checked the passkey when Remove (from another device) deletes it.
    let signingIn!: Promise<Response>;
    await t.kernel.db.transaction(async (tx) => {
      await tx.select().from(credential).where(eq(credential.id, ofPhone!.id)).for("update");
      signingIn = signIn(phone);
      await waitingOnLocks(1);
      await tx.delete(credential).where(eq(credential.id, ofPhone!.id));
    });
    expect((await signingIn).status).toBe(401);
    expect(await me(browser)).toMatchObject({ signedIn: false });
  });

  it("stops the window signing in with Windows Hello, even with a challenge asked before", async () => {
    await firstPasskey();
    await connect();
    const hello = await windowPasskey();
    const [, ofWindow] = await list();
    // The window asked to sign in just before: its answer comes after the removal.
    const asked = await options(window("/api/auth/login/options", { method: "POST" }));
    expect((await remove(ofWindow!.id)).status).toBe(200);

    t.cookies.delete(SESSION_COOKIE);
    const late = await window("/api/auth/login/verify", {
      method: "POST",
      json: { response: hello.login(asked) },
    });
    expect(late.status).toBe(401);
    // Nor can it start again: the window has no passkey to ask for.
    const again = await window("/api/auth/login/options", { method: "POST" });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toContain("no passkey yet");
    expect(await windowSessions()).toHaveLength(0);
    expect(await me()).toMatchObject({ signedIn: false });
  });
});
