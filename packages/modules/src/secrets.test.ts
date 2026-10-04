// Google's tokens are sealed with the vault key at rest (D58), and 0028's code steps seal the
// ones saved before, or open them again for an older Hearth.
import { randomBytes } from "node:crypto";
import { googleAccount } from "@hearth/db";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Vault } from "./browser/vault.ts";
import { GoogleClient, SCOPES } from "./google/client.ts";
import { FakeGoogle } from "./google/fake.ts";
import { ALL_MODULES } from "./index.ts";
import { isSealed, openGoogleTokens, sealGoogleTokens, secretMigrations } from "./secrets.ts";

const ME = "owner@example.com";
const PROFILE = "https://gmail.googleapis.com/gmail/v1/users/me/profile";

let t: TestKernel;
let g: FakeGoogle;
let vault: Vault;
beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  g = new FakeGoogle(ME);
  g.clock = t.clock;
  g.grants = ["openid", "email", ...SCOPES.gmail];
  vault = new Vault(randomBytes(32));
});
afterEach(() => t.destroy());

const clientWith = (v: Vault | null) =>
  new GoogleClient({
    clientId: "test-client",
    clientSecret: "test-secret",
    redirectUri: "http://localhost:4400/api/google/callback",
    fetch: (url, init) => g.fetch(url, init),
    db: t.tdb.db,
    now: () => t.clock.now(),
    vault: v,
  });
const signIn = async (client: GoogleClient) => {
  const url = new URL(await client.startSignIn(t.tdb.db, [...SCOPES.gmail]));
  await client.finishSignIn(t.tdb.db, url.searchParams.get("state")!, "the-code");
};
const saved = async () =>
  (await t.tdb.db.select().from(googleAccount).where(eq(googleAccount.email, ME)))[0]!;
const expire = () =>
  t.tdb.db
    .update(googleAccount)
    .set({ accessExpiresAt: new Date(t.clock.now().getTime() - 1000) })
    .where(eq(googleAccount.email, ME));
const lastRefresh = () =>
  g.calls.filter((c) => c.path === "/token").at(-1)?.body as Record<string, string>;
const inTx = async <T>(fn: (c: { query: never }) => Promise<T>): Promise<T> => {
  const c = await t.tdb.pool.connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c as never);
    await c.query("COMMIT");
    return out;
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    c.release();
  }
};

describe("Google's tokens at rest", () => {
  it("are saved sealed, and still work", async () => {
    await signIn(clientWith(vault));
    const row = await saved();
    expect(isSealed(row.refreshToken)).toBe(true);
    expect(isSealed(row.accessToken!)).toBe(true);
    expect(JSON.stringify(row)).not.toContain('"rt"');

    // A fresh process opens them: the saved access token, then a refresh with the refresh token.
    expect(await clientWith(vault).call(t.tdb.db, ME, "GET", PROFILE)).toMatchObject({});
    await expire();
    await clientWith(vault).call(t.tdb.db, ME, "GET", PROFILE);
    expect(lastRefresh()).toMatchObject({ grant_type: "refresh_token", refresh_token: "rt" });
    expect(isSealed((await saved()).accessToken!)).toBe(true);

    // Disconnecting tells Google to drop the token itself, not its sealed copy.
    await clientWith(vault).revoke(row.refreshToken, ME);
    expect(g.calls.at(-1)).toMatchObject({ path: "/revoke", body: { token: "rt" } });
  });

  it("saved before sealing are read as they are, sealed by 0028, and opened again going back", async () => {
    await signIn(clientWith(null));
    expect((await saved()).refreshToken).toBe("rt");
    await expire();
    await clientWith(vault).call(t.tdb.db, ME, "GET", PROFILE);
    expect(lastRefresh()).toMatchObject({ refresh_token: "rt" });

    expect(await inTx((c) => sealGoogleTokens(c, vault))).toBe(1);
    expect(isSealed((await saved()).refreshToken)).toBe(true);
    // Running it again changes nothing.
    expect(await inTx((c) => sealGoogleTokens(c, vault))).toBe(0);
    await expire();
    await clientWith(vault).call(t.tdb.db, ME, "GET", PROFILE);
    expect(lastRefresh()).toMatchObject({ refresh_token: "rt" });

    // Another key can't open them, so going back stops rather than hand them on sealed.
    const other = secretMigrations(new Vault(randomBytes(32)))["0028_trust"];
    await expect(inTx((c) => other.down(c))).rejects.toThrow(/Connect it again/);
    expect(isSealed((await saved()).refreshToken)).toBe(true);
    expect(await inTx((c) => openGoogleTokens(c, vault))).toBe(1);
    expect((await saved()).refreshToken).toBe("rt");
  });

  it("sealed with a key this Hearth doesn't have, say to connect again", async () => {
    await signIn(clientWith(vault));
    await expire();
    const stranger = clientWith(new Vault(randomBytes(32)));
    await expect(stranger.call(t.tdb.db, ME, "GET", PROFILE)).rejects.toThrow(
      /can't unlock its Google sign-in/,
    );
    expect(await saved()).toMatchObject({ status: "failing" });
  });
});
