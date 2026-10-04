import { win32 } from "node:path";
import { REQUEST_TIMEOUT_MS } from "@hearth/modules";
import { describe, expect, it } from "vitest";
import { CALL_TIMEOUT_MS } from "./browser/bridge.ts";
import {
  asWindowsService,
  createLauncher,
  DEFAULT_TASK,
  directArgs,
  directLauncher,
  findChrome,
  LAUNCH_TIMEOUT_MS,
  loadLaunchConfig,
  splitArgs,
  taskLauncher,
} from "./browser/launch.ts";
import { OPEN_TIMING } from "./browser/opener.ts";

describe("how Hearth opens Chrome", () => {
  it("runs the Windows task from a service, and starts Chrome itself otherwise", () => {
    expect(loadLaunchConfig({ HEARTH_AS_SERVICE: "1" }, "win32")).toMatchObject({
      mode: "task",
      task: DEFAULT_TASK,
    });
    expect(loadLaunchConfig({}, "win32", "ana").mode).toBe("direct");
    // A service whose settings are from before HEARTH_AS_SERVICE: its account gives it away.
    expect(loadLaunchConfig({}, "win32", "LOCAL SERVICE").mode).toBe("task");
    expect(loadLaunchConfig({}, "linux", "LOCAL SERVICE").mode).toBe("direct");
    const german = "C:\\Windows\\ServiceProfiles\\LocalService";
    expect(asWindowsService({}, "win32", "LOKALER DIENST", german)).toBe(true);
    const system = "C:\\Windows\\system32\\config\\systemprofile";
    expect(asWindowsService({}, "win32", "SYSTEM", system)).toBe(true);
    expect(asWindowsService({}, "win32", "ana", "C:\\Users\\ana")).toBe(false);
    expect(loadLaunchConfig({}, "linux").mode).toBe("direct");
    const off = loadLaunchConfig({ HEARTH_CHROME_LAUNCH: "off", HEARTH_AS_SERVICE: "1" }, "win32");
    expect(off.mode).toBe("off");
    expect(createLauncher(off)).toBeNull();
    // Never Chrome straight from a service: it would open where nobody can see it.
    const direct = loadLaunchConfig({ HEARTH_CHROME_LAUNCH: "direct" }, "win32");
    const quiet = console.warn;
    console.warn = () => {};
    try {
      expect(createLauncher(direct, { HEARTH_AS_SERVICE: "1" }, "win32")?.hint).toContain(
        "signed in",
      );
      expect(createLauncher(direct, {}, "win32", "SYSTEM")?.hint).toContain("signed in");
    } finally {
      console.warn = quiet;
    }
  });

  it("starts Chrome without a window of its own, in your profile", () => {
    const config = loadLaunchConfig(
      { HEARTH_CHROME_PROFILE: "Profile 1", HEARTH_CHROME_ARGS: " --no-sandbox  --x=1 " },
      "linux",
    );
    expect(directArgs(config)).toEqual([
      "--no-startup-window",
      "--profile-directory=Profile 1",
      "--ignore-profile-directory-if-not-exists",
      "--no-sandbox",
      "--x=1",
    ]);
  });

  it("keeps quoted switches together", () => {
    expect(splitArgs(' --a=1  --user-data-dir="C:\\Users\\Ana Lima\\p" "--b c" ')).toEqual([
      "--a=1",
      "--user-data-dir=C:\\Users\\Ana Lima\\p",
      "--b c",
    ]);
  });

  it("answers Jarvis before Jarvis gives up, even when Chrome has to be opened first", () => {
    const worst =
      OPEN_TIMING.startGraceMs + LAUNCH_TIMEOUT_MS + OPEN_TIMING.connectMs + CALL_TIMEOUT_MS;
    expect(worst + 10_000).toBeLessThanOrEqual(REQUEST_TIMEOUT_MS);
  });

  it("finds Chrome where it's usually installed", () => {
    const env = { ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" };
    const local = win32.join(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe");
    expect(findChrome(env, "win32", (p) => p === local)).toBe(local);
    expect(
      findChrome({ PATH: "/usr/bin:/snap/bin" }, "linux", (p) => p === "/snap/bin/chromium"),
    ).toBe("/snap/bin/chromium");
    expect(findChrome({ PATH: "/usr/bin" }, "linux", () => false)).toBeNull();
  });

  it("says what to fix when the Windows task can't run", async () => {
    const ran: string[][] = [];
    const ok = taskLauncher(DEFAULT_TASK, async (file, args) => {
      ran.push([file, ...args]);
      return { code: 0, output: "SUCCESS: Attempted to run the scheduled task" };
    });
    await ok.open();
    expect(ran).toEqual([
      [expect.stringMatching(/schtasks\.exe$/), "/Run", "/TN", "Hearth Chrome"],
    ]);

    const missing = taskLauncher(DEFAULT_TASK, async () => ({
      code: 1,
      output: "ERROR: The system cannot find the file specified.\n",
    }));
    await expect(missing.open()).rejects.toThrow(
      'Windows couldn\'t run the "Hearth Chrome" task that opens Chrome (ERROR: The system cannot find the file specified.). Run ops\\windows\\install.ps1 again as administrator.',
    );
  });

  it("starts Chrome directly, or says it can't find it", async () => {
    const started: string[][] = [];
    const launcher = directLauncher(
      { chromePath: null, profile: null, args: [] },
      async (file, args) => {
        started.push([file, ...args]);
      },
      () => "/usr/bin/google-chrome",
    );
    await launcher.open();
    expect(started).toEqual([["/usr/bin/google-chrome", "--no-startup-window"]]);

    const nowhere = directLauncher(
      { chromePath: null, profile: null, args: [] },
      undefined,
      () => null,
    );
    await expect(nowhere.open()).rejects.toThrow("Set HEARTH_CHROME_PATH");

    const broken = directLauncher({ chromePath: "/nope/chrome", profile: null, args: [] });
    await expect(broken.open()).rejects.toThrow("Hearth couldn't start Chrome at /nope/chrome");
  });
});
