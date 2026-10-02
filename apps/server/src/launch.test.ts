import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createLauncher,
  DEFAULT_TASK,
  directArgs,
  directLauncher,
  findChrome,
  loadLaunchConfig,
  taskLauncher,
} from "./browser/launch.ts";

describe("how Hearth opens Chrome", () => {
  it("runs the Windows task from a service, and starts Chrome itself otherwise", () => {
    expect(loadLaunchConfig({ HEARTH_AS_SERVICE: "1" }, "win32")).toMatchObject({
      mode: "task",
      task: DEFAULT_TASK,
    });
    expect(loadLaunchConfig({}, "win32").mode).toBe("direct");
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
      "--no-sandbox",
      "--x=1",
    ]);
  });

  it("finds Chrome where it's usually installed", () => {
    const env = { ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" };
    const local = join(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe");
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
