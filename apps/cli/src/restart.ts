// `hearth restart [server|worker|jarvis|all]`: restarts Hearth's Windows services and the Jarvis
// task from your own account, with the rights install.ps1 gave it. ops/windows/restart.ps1 does
// the work, with the same stop logic as update.ps1, and waits until what it restarted reports in.
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

export const RESTARTABLE = ["server", "worker", "jarvis", "all"] as const;
export const RESTART_USAGE = "Usage: hearth restart [server|worker|jarvis|all]";

/** The Hearth folder this CLI runs from (apps/cli/src, three up). */
export const HEARTH_ROOT = resolve(import.meta.dirname, "..", "..", "..");

/** The PowerShell command line that restarts `what`, or null when that isn't something to restart. */
export function restartCommand(
  what: string | undefined,
  root = HEARTH_ROOT,
): { cmd: string; args: string[] } | null {
  const target = what ?? "all";
  if (!(RESTARTABLE as readonly string[]).includes(target)) return null;
  const script = join(root, "ops", "windows", "restart.ps1");
  return {
    cmd: "powershell.exe",
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Service", target],
  };
}

type Spawn = (cmd: string, args: string[]) => Promise<number>;

const spawnVisible: Spawn = (cmd, args) =>
  new Promise((done) => {
    const child = spawn(cmd, args, { stdio: "inherit", windowsHide: true });
    child.on("error", () => done(127));
    child.on("close", (code) => done(code ?? 1));
  });

export async function restart(
  args: string[],
  platform: NodeJS.Platform = process.platform,
  run: Spawn = spawnVisible,
): Promise<number> {
  const command = restartCommand(args[0]);
  if (!command || args.length > 1) {
    console.error(RESTART_USAGE);
    return 2;
  }
  if (platform !== "win32") {
    console.error(
      "hearth restart manages Hearth's Windows services. Here, restart Hearth the way you started it.",
    );
    return 2;
  }
  const code = await run(command.cmd, command.args);
  if (code === 127) console.error("Couldn't run PowerShell to restart Hearth.");
  return code;
}
