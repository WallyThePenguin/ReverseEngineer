// `hearth device unpair desktop` works like Disconnect in Settings: it signs Hearth's window on
// the PC out too (D53), not just the app's token.
import { PRINCIPAL } from "@hearth/core";
import { createSession, session } from "@hearth/db";
import { createTestDatabase, type TestDatabase } from "@hearth/db/testing";
import { pairDevice } from "@hearth/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./main.ts";

let tdb: TestDatabase;
beforeEach(async () => {
  tdb = await createTestDatabase();
  vi.stubEnv("HEARTH_DATABASE_URL", tdb.url);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await tdb.destroy();
});

describe("hearth device unpair", () => {
  it("signs the desktop app's window out along with its token", async () => {
    await pairDevice(tdb.db, "desktop");
    const browser = (label: string) =>
      createSession(tdb.db, { principal: PRINCIPAL.owner, kind: "browser", label, ttlDays: 30 });
    await browser("window:desktop");
    await browser("your laptop");
    const said: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line) => said.push(String(line)));

    expect(await main(["device", "unpair", "desktop"])).toBe(0);
    const rows = await tdb.db.select().from(session);
    const signedIn = rows.filter((r) => !r.revokedAt).map((r) => r.label);
    expect(signedIn).toEqual(["your laptop"]);
    expect(said).toEqual(["Signed out 2 sign-in(s) for desktop."]);
  });
});
