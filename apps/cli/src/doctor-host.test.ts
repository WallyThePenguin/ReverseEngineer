import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeepHealth } from "@hearth/server";
import { afterEach, describe, expect, it } from "vitest";
import type { Runner } from "./backup.ts";
import {
  checkBuild,
  checkChromeLink,
  checkDiskSpace,
  checkServices,
  checkTailscale,
  probeServer,
} from "./doctor-host.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "fedcba9876543210fedcba9876543210fedcba98";
const answers =
  (code: number, stdout = "", stderr = ""): Runner =>
  async () => ({ code, stdout, stderr });
const marks = (checks: { name: string; mark: string }[]) => checks.map((c) => [c.name, c.mark]);

let dist: string | null = null;
afterEach(async () => {
  if (dist) await rm(dist, { recursive: true, force: true });
  dist = null;
});

describe("hearth doctor, the running install", () => {
  it("fails a stopped service and an idle Jarvis, warns about what isn't installed", async () => {
    const states = {
      "hearth-server": "Running",
      "hearth-worker": "Stopped",
      "Hearth Jarvis": "Ready",
      "Hearth Chrome": "Ready",
      "Hearth backup": "Ready",
    };
    const up = await checkServices("win32", answers(0, JSON.stringify(states)));
    expect(up.installed).toBe(true);
    expect(marks(up.checks)).toEqual([
      ["hearth-server", "ok"],
      ["hearth-worker", "fail"],
      ["Jarvis task", "fail"],
      ["Backup task", "ok"],
    ]);
    expect(up.checks[1]?.detail).toContain("pnpm hearth restart worker");

    const off = { ...states, "Hearth Chrome": "Disabled", "Hearth Jarvis": "Running" };
    const disabled = await checkServices("win32", answers(0, JSON.stringify(off)));
    expect(marks(disabled.checks).slice(2)).toEqual([
      ["Jarvis task", "ok"],
      ["Backup task", "ok"],
      ["Chrome task", "fail"],
    ]);

    const none = await checkServices("win32", answers(0, "{}"));
    expect(none.installed).toBe(false);
    expect(none.checks.every((c) => c.mark === "warn")).toBe(true);
    expect(await checkServices("linux", answers(0))).toEqual({ checks: [], installed: false });
  });

  it("asks the server how it is, and fails it when it doesn't answer", async () => {
    const report = { sha: SHA, startedAt: "2026-10-04T12:00:00Z" } as DeepHealth;
    let asked = "";
    const ok = await probeServer({ HEARTH_PORT: "4640" }, async (url) => {
      asked = String(url);
      return Response.json(report);
    });
    expect(asked).toBe("http://127.0.0.1:4640/api/health/deep");
    expect(ok.check).toMatchObject({ mark: "ok", detail: expect.stringContaining("0123456") });
    expect(ok.report).toEqual(report);

    const down = async () => {
      throw new TypeError("fetch failed");
    };
    expect((await probeServer({}, down)).check.mark).toBe("fail");
    expect((await probeServer({}, down, false)).check.mark).toBe("warn");
    const old = await probeServer({}, async () => new Response("", { status: 404 }));
    expect(old.check).toMatchObject({ mark: "warn", detail: expect.stringContaining("restart") });
  });

  it("says whether the web build and the server are the code on disk", async () => {
    dist = await mkdtemp(join(tmpdir(), "hearth-dist-"));
    const env = { HEARTH_WEB_DIST: dist };
    const git = answers(0, `${SHA}\n`);
    expect((await checkBuild(env, git, null)).mark).toBe("warn"); // no build at all
    await writeFile(join(dist, "index.html"), "<!doctype html>");
    expect((await checkBuild(env, git, null)).detail).toMatch(/before builds were stamped/);

    const stamp = { sha: SHA, builtAt: "2026-10-04T12:00:00.000Z", migrations: [] };
    await writeFile(join(dist, "version.json"), JSON.stringify(stamp));
    expect((await checkBuild(env, git, null)).mark).toBe("ok");
    const serving = (sha: string) => ({ sha }) as DeepHealth;
    expect((await checkBuild(env, git, serving(SHA))).detail).toContain("the server runs it");

    const stale = await checkBuild(env, git, serving(OTHER));
    expect(stale).toMatchObject({ mark: "fail", detail: expect.stringContaining("still runs") });
    const moved = await checkBuild(env, answers(0, OTHER), null);
    expect(moved).toMatchObject({ mark: "fail", detail: expect.stringContaining("build:web") });
  });

  it("checks that Tailscale Serve passes Hearth's address to Hearth", async () => {
    const env = { HEARTH_ORIGIN: "https://pc.tail1234.ts.net", HEARTH_PORT: "4400" };
    const serve = (proxy: string, where: "bg" | "fg" = "bg") => {
      const web = { "pc.tail1234.ts.net:443": { Handlers: { "/": { Proxy: proxy } } } };
      return JSON.stringify(where === "bg" ? { Web: web } : { Foreground: { abc: { Web: web } } });
    };
    expect(await checkTailscale({ HEARTH_ORIGIN: "http://localhost:4400" }, answers(0))).toBeNull();
    expect(await checkTailscale(env, answers(0, serve("http://127.0.0.1:4400")))).toMatchObject({
      mark: "ok",
    });
    expect(
      (await checkTailscale(env, answers(0, serve("http://localhost:4400", "fg"))))?.mark,
    ).toBe("ok");

    const wrong = await checkTailscale(env, answers(0, serve("http://127.0.0.1:44001")));
    expect(wrong).toMatchObject({ mark: "fail", detail: expect.stringContaining("not Hearth") });
    const none = await checkTailscale(env, answers(0, "{}"));
    expect(none?.detail).toContain("tailscale serve --bg 4400");
    expect((await checkTailscale(env, answers(127)))?.mark).toBe("fail");
    expect((await checkTailscale(env, answers(1, "", "not logged in\n")))?.detail).toContain(
      "not logged in",
    );
  });

  it("names the Chrome extension the server sees", () => {
    expect(checkChromeLink(null)).toBeNull();
    const at = (connected: boolean, more: Partial<NonNullable<DeepHealth["browser"]>> = {}) =>
      ({
        browser: {
          connected,
          version: "1.4.0",
          since: "2026-10-04T12:00:00Z",
          paired: true,
          openError: null,
          ...more,
        },
      }) as DeepHealth;
    expect(checkChromeLink(at(true))).toMatchObject({
      mark: "ok",
      detail: expect.stringContaining("1.4.0"),
    });
    expect(checkChromeLink(at(false))?.detail).toContain("isn't connected");
    expect(checkChromeLink(at(false, { paired: false }))?.detail).toContain(
      "No extension is paired",
    );
    const blocked = checkChromeLink(at(false, { openError: "Nobody is signed in to Windows." }));
    expect(blocked).toMatchObject({ mark: "warn", detail: expect.stringContaining("Nobody is") });
  });

  it("checks each drive once", async () => {
    const drives = await checkDiskSpace({ HEARTH_DATA_DIR: process.cwd() });
    expect(drives.length).toBeGreaterThan(0);
    expect(new Set(drives.map((d) => d.name)).size).toBe(drives.length);
    expect(drives.every((d) => d.name.startsWith("Disk "))).toBe(true);
  });
});
