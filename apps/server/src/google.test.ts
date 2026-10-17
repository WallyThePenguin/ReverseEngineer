import { oauthState } from "@hearth/db";
import { GOOGLE_SERVICE, SCOPES } from "@hearth/modules";
import { FakeGoogle } from "@hearth/modules/google-testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestServer, type TestServer } from "./testing/server.ts";

let t: TestServer;

beforeEach(async () => {
  t = await createTestServer({ devAuth: true });
  t.kernel.services[GOOGLE_SERVICE] = new FakeGoogle("owner@example.com").client();
});
afterEach(() => t.destroy());

const started = async () => (await t.tdb.db.select().from(oauthState)).length;

describe("connecting Google", () => {
  it("starts nothing from a link: a GET is refused, with no redirect", async () => {
    const res = await t.browser("/api/google/connect?for=calendar,gmail");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(res.headers.get("location")).toBeNull();
    expect(await started()).toBe(0);
  });

  it("starts nothing from a link that spells /api another way", async () => {
    const res = await t.browser("/%61pi/google/connect?for=gmail");
    expect([404, 405]).toContain(res.status);
    expect(res.headers.get("location")).toBeNull();
    expect(await started()).toBe(0);
  });

  it("gives Hearth's own page Google's consent screen for what it asked", async () => {
    const res = await t.browser("/api/google/connect?for=calendar,gmail", { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const url = new URL(((await res.json()) as { url: string }).url);
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("scope")!.split(" ")).toEqual(
      expect.arrayContaining([...SCOPES.calendar, ...SCOPES.gmail]),
    );
    const [row] = await t.tdb.db.select().from(oauthState);
    expect(url.searchParams.get("state")).toBe(row!.state);
  });

  it("refuses another site's page asking, however it spells the path", async () => {
    const elsewhere = { origin: "https://evil.example", "sec-fetch-site": "cross-site" };
    for (const path of ["/api/google/connect?for=gmail", "/%61pi/google/connect?for=gmail"]) {
      const res = await t.browser(path, { method: "POST", headers: elsewhere });
      expect(res.status).toBe(403);
    }
    expect(await started()).toBe(0);
  });

  it("says why when there is nothing to connect", async () => {
    const res = await t.browser("/api/google/connect?for=drive", { method: "POST" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Nothing to connect." });
  });
});
