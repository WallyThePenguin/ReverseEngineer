import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@hearth/db";
import { systemCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { ALL_MODULES } from "@hearth/modules";
import type { DeepHealth } from "@hearth/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Runner } from "./backup.ts";
import { runDoctor } from "./doctor-run.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";

let t: TestKernel;
let dir: string;
beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  dir = await mkdtemp(join(tmpdir(), "hearth-doctor-"));
});
afterEach(async () => {
  await t.destroy();
  await rm(dir, { recursive: true, force: true });
});

/** Windows, the services and tasks, git, restic and Tailscale as on the PC; nothing real is asked. */
const windows: Runner = async (cmd, args) => {
  const out = (stdout: string) => ({ code: 0, stdout, stderr: "" });
  if (cmd === "powershell.exe")
    return out(
      JSON.stringify({
        "hearth-server": "Running",
        "hearth-worker": "Running",
        "Hearth Jarvis": "Running",
        "Hearth Chrome": "Disabled",
        "Hearth backup": "Ready",
      }),
    );
  if (cmd === "git") return out(`${SHA}\n`);
  if (cmd === "restic") return out("restic 0.18.0 compiled with go1.24 on windows/amd64\n");
  if (cmd === "tailscale" && args[0] === "serve") {
    const web = {
      "pc.tail1.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4640" } } },
    };
    return out(JSON.stringify({ Web: web }));
  }
  return out("");
};

describe("hearth doctor, all of it", () => {
  // update.ps1 tells a check that broke in the update from one that was broken before by its
  // name, so two checks must never share one: a backup that failed before the update read as the
  // backup task's "ok", and the update was rolled back for it.
  it("names every check apart, the way update.ps1 compares them", async () => {
    for (const component of ["worker", "jarvis", "disk", "server"])
      await t.kernel.execute(
        "system.report",
        { component, status: "ok", detail: "Running" },
        systemCaller(),
      );
    await t.kernel.execute(
      "system.backup_finished",
      { ok: false, detail: "Upload failed" },
      systemCaller(),
    );
    const dist = join(dir, "dist");
    await mkdir(dist);
    await writeFile(join(dist, "index.html"), "<!doctype html>");
    const stamp = { sha: SHA, builtAt: t.clock.now().toISOString(), migrations: [] };
    await writeFile(join(dist, "version.json"), JSON.stringify(stamp));
    const report = {
      sha: SHA,
      startedAt: t.clock.now().toISOString(),
      browser: { connected: false, version: null, since: null, paired: true, openError: null },
    } as unknown as DeepHealth;

    const result = await runDoctor({
      env: {
        HEARTH_PORT: "4640",
        HEARTH_ORIGIN: "https://pc.tail1.ts.net",
        HEARTH_WEB_DIST: dist,
        HEARTH_DATA_DIR: dir,
        HEARTH_BACKUP_REPOSITORY: "rclone:gdrive:hearth",
        RESTIC_PASSWORD: "x",
        ANTHROPIC_API_KEY: "x",
      },
      platform: "win32",
      run: windows,
      fetch: async () => Response.json(report),
      root: dir,
      connectDb: () => connect(t.tdb.url, { max: 2 }),
      now: t.clock.now(),
    });

    const names = result.checks.map((c) => c.name);
    const twice = names.filter((n, i) => names.indexOf(n) !== i);
    expect(twice).toEqual([]);
    // The task and the component are both there, each under its own name.
    const mark = (name: string) => result.checks.find((c) => c.name === name)?.mark;
    expect(mark("Backup task")).toBe("ok");
    expect(mark("backup")).toBe("fail");
    expect(mark("Chrome task")).toBe("fail");
    expect(mark("Jarvis task")).toBe("ok");
    expect(result.ok).toBe(false);
  });
});
