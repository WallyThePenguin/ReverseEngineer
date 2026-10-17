// Opening your Chrome when Jarvis needs it and it's closed. On Windows, Hearth's server runs as a
// service, which can't show anything on your desktop, so it asks Windows to run the "Hearth
// Chrome" task that install.ps1 made: it starts Chrome as you, on your desktop, in your profile.
// When you run Hearth yourself (and on a Mac or Linux), it starts Chrome directly.
//
// Chrome starts with --no-startup-window: no window of its own until Jarvis opens one, and when
// Chrome is already running it does nothing. The extension asks to keep Chrome running in the
// background, so it stays up with no windows open.
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, posix, win32 } from "node:path";
import { ActionError } from "@hearth/kernel";

export type LaunchMode = "task" | "direct" | "off";

export interface LaunchConfig {
  mode: LaunchMode;
  /** The Windows task to run, in task mode. */
  task: string;
  /** Chrome's program, in direct mode. Found by itself when not set. */
  chromePath: string | null;
  /** Chrome's profile folder name, like "Default" or "Profile 1", in direct mode. */
  profile: string | null;
  /** More switches for Chrome in direct mode, for tests: HEARTH_CHROME_ARGS, space-separated. */
  args: string[];
}

export interface ChromeLauncher {
  /** What a person can check when Chrome was asked to start but never connected. */
  readonly hint: string;
  /** Asks for Chrome to start. Throws an ActionError saying what to fix when it can't. */
  open(): Promise<void>;
}

export const DEFAULT_TASK = "Hearth Chrome";
const SWITCHES = ["--no-startup-window"];

/** The account Hearth runs as, or "" when Windows won't say. */
function whoAmI(): string {
  try {
    return userInfo().username;
  } catch {
    return "";
  }
}

/**
 * Whether Hearth runs as a Windows service, which can't show anything on your desktop. The
 * services' settings say so, and so does running as a service account, in case those settings
 * are from before they did. Account names are translated on some Windows; their folders aren't.
 */
export function asWindowsService(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  user: string = whoAmI(),
  home: string = homedir(),
): boolean {
  if (platform !== "win32") return false;
  return (
    env.HEARTH_AS_SERVICE === "1" ||
    /^(local service|network service|system)$|\$$/i.test(user) ||
    /\\(ServiceProfiles|system32\\config\\systemprofile)(\\|$)/i.test(home)
  );
}

export function loadLaunchConfig(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  user?: string,
): LaunchConfig {
  const asked = env.HEARTH_CHROME_LAUNCH;
  const mode: LaunchMode =
    asked === "task" || asked === "direct" || asked === "off"
      ? asked
      : asWindowsService(env, platform, user)
        ? "task"
        : "direct";
  return {
    mode,
    task: env.HEARTH_CHROME_TASK || DEFAULT_TASK,
    chromePath: env.HEARTH_CHROME_PATH || null,
    profile: env.HEARTH_CHROME_PROFILE || null,
    args: splitArgs(env.HEARTH_CHROME_ARGS ?? ""),
  };
}

/** Splits switches on spaces, keeping "quoted parts" together. */
export function splitArgs(text: string): string[] {
  return [...text.matchAll(/(?:[^\s"]+|"[^"]*")+/g)].map((m) => m[0].replace(/"/g, ""));
}

/** Where Chrome usually is, most likely first. */
export function chromeCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  // That platform's separators, whatever this runs on.
  const { join } = platform === "win32" ? win32 : posix;
  if (platform === "win32") {
    const app = join("Google", "Chrome", "Application", "chrome.exe");
    return [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA]
      .filter((dir): dir is string => Boolean(dir))
      .map((dir) => join(dir, app));
  }
  if (platform === "darwin") {
    const app = "Google Chrome.app/Contents/MacOS/Google Chrome";
    return [join("/Applications", app), join(env.HOME ?? "", "Applications", app)];
  }
  const dirs = (env.PATH ?? "/usr/bin").split(":").filter(Boolean);
  const names = ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"];
  return names.flatMap((name) => dirs.map((dir) => join(dir, name)));
}

export function findChrome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string | null {
  return chromeCandidates(env, platform).find((p) => exists(p)) ?? null;
}

/** The switches Chrome is started with in direct mode. */
export function directArgs(config: Pick<LaunchConfig, "profile" | "args">): string[] {
  return [
    ...SWITCHES,
    // A profile folder that's gone opens the last one used, not a new, empty profile.
    ...(config.profile
      ? [`--profile-directory=${config.profile}`, "--ignore-profile-directory-if-not-exists"]
      : []),
    ...config.args,
  ];
}

export type Runner = (file: string, args: string[]) => Promise<{ code: number; output: string }>;

/** How long asking Windows to run the task may take. */
export const LAUNCH_TIMEOUT_MS = 10_000;

const runProgram: Runner = (file, args) =>
  new Promise((resolve) => {
    const opts = { timeout: LAUNCH_TIMEOUT_MS, windowsHide: true };
    execFile(file, args, opts, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({ code, output: `${stderr}\n${stdout}`.trim() });
    });
  });

const SCHTASKS = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "schtasks.exe");

/**
 * Runs the scheduled task install.ps1 made, which starts Chrome as you on your desktop. Windows
 * says yes even when you're signed out and it won't run, so only Chrome connecting proves it.
 */
export function taskLauncher(task: string, run: Runner = runProgram): ChromeLauncher {
  return {
    hint: "Windows only opens it while you're signed in on the PC.",
    async open() {
      const { code, output } = await run(SCHTASKS, ["/Run", "/TN", task]);
      if (code === 0) return;
      const why = output.split(/\r?\n/).find((line) => line.trim()) ?? `exit ${code}`;
      throw new ActionError(
        "unavailable",
        `Windows couldn't run the "${task}" task that opens Chrome (${why.trim()}). Run ops\\windows\\install.ps1 again as administrator.`,
      );
    },
  };
}

export type Starter = (file: string, args: string[]) => Promise<void>;

/** Starts a program that outlives Hearth, without waiting for it. */
const startDetached: Starter = (file, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });

/** Starts Chrome itself. Only for a Hearth you run as yourself, so Chrome opens where you are. */
export function directLauncher(
  config: Pick<LaunchConfig, "chromePath" | "profile" | "args">,
  start: Starter = startDetached,
  find: () => string | null = () => findChrome(),
): ChromeLauncher {
  return {
    hint: "",
    async open() {
      const chrome = config.chromePath ?? find();
      if (!chrome)
        throw new ActionError(
          "unavailable",
          "Nook can't find Chrome on this computer. Set HEARTH_CHROME_PATH to it.",
        );
      try {
        await start(chrome, directArgs(config));
      } catch (err) {
        throw new ActionError(
          "unavailable",
          `Nook couldn't start Chrome at ${chrome}: ${(err as Error).message}`,
        );
      }
    },
  };
}

/** The launcher for this setup, or null when Hearth leaves opening Chrome to you. */
export function createLauncher(
  config: LaunchConfig,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  user?: string,
): ChromeLauncher | null {
  if (config.mode === "off") return null;
  if (config.mode === "task") return taskLauncher(config.task);
  // A Windows service starting Chrome would put it where nobody can see it, holding your profile.
  if (asWindowsService(env, platform, user)) {
    console.warn(
      `HEARTH_CHROME_LAUNCH=direct doesn't work from a Windows service; using the "${config.task}" task.`,
    );
    return taskLauncher(config.task);
  }
  return directLauncher(config);
}
