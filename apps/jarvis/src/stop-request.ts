// How an update or `hearth restart` stops Jarvis from your own account (D63). As the "Hearth
// Jarvis" task, Jarvis runs as you but in Windows' session 0, where your unelevated account can
// neither read its start time nor end it. On 2026-10-05 Stop-Process said "Access is denied", the
// old Jarvis kept running with its log open, and the task couldn't start the new one. So
// ops/windows/control.ps1 asks instead: it writes hearth-jarvis.stop next to Jarvis's pid file,
// and Jarvis, checking once a second, stops the way SIGTERM stops it. Jarvis also stops once the
// task's cmd.exe is gone, which is what ending the task does, so it never outlives its task run.
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";

/** Who wrote a stop request, and whether they may stop Jarvis. */
export interface Asker {
  trusted: boolean;
  who: string;
}

export interface StopWatchOptions {
  /** The request: hearth-jarvis.stop in Hearth's services folder. */
  file: string;
  /** When this Jarvis started: a request from before then was for an earlier one. */
  startedAt: number;
  /** Stops Jarvis, saying why. Called at most once. */
  stop: (why: string) => void;
  log: (msg: string) => void;
  /** By default, the request file's owner (ownerOf). */
  whoAsked?: (file: string) => Promise<Asker>;
  /** Whether the process that started Jarvis (the task's cmd.exe) is still running. */
  parentAlive?: () => boolean;
  everyMs?: number;
}

/** Watches for a request to stop, and for the end of the task run. Returns how to stop watching. */
export function watchForStopRequest(opts: StopWatchOptions): () => void {
  const whoAsked = opts.whoAsked ?? ownerOf;
  const parent = process.ppid;
  const parentAlive = opts.parentAlive ?? (() => isRunning(parent));
  // Each request is looked at once, by its time: one turned down isn't checked every second.
  let seen = 0;
  let asking = false;
  let done = false;
  let timer: NodeJS.Timeout | undefined;
  const unwatch = () => {
    done = true;
    clearInterval(timer);
  };
  const finish = (why: string) => {
    unwatch();
    opts.stop(why);
  };
  const check = () => {
    if (done || asking) return;
    if (!parentAlive()) return finish("The task that started Jarvis has ended");
    const at = modifiedAt(opts.file);
    if (at <= opts.startedAt || at === seen) return;
    seen = at;
    asking = true;
    whoAsked(opts.file)
      .catch((err): Asker => ({ trusted: false, who: `someone (${String(err)})` }))
      .then((asker) => {
        asking = false;
        if (done) return;
        if (asker.trusted) return finish(`${asker.who} asked Jarvis to stop (${opts.file})`);
        opts.log(
          `Ignored a request to stop from ${asker.who} (${opts.file}): only your account or an administrator may stop Jarvis this way.`,
        );
      });
  };
  timer = setInterval(check, opts.everyMs ?? 1000);
  timer.unref();
  return unwatch;
}

/** When the file was last written, or 0 when there's none (or it can't be read). */
function modifiedAt(file: string): number {
  try {
    return statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  } catch {
    return 0;
  }
}

/** Whether a process is still there. One Jarvis may not look at (EPERM) still is. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

const POWERSHELL = join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
/** The file's owner and this process's account, as SIDs: Node can read neither on Windows. */
const OWNER_SCRIPT =
  "(Get-Acl -LiteralPath $env:HEARTH_STOP_FILE).GetOwner([Security.Principal.SecurityIdentifier]).Value; [Security.Principal.WindowsIdentity]::GetCurrent().User.Value";
/** Besides your own account: the Administrators group (what an elevated admin's files belong to). */
const ADMINS: Record<string, string> = {
  "S-1-5-32-544": "An administrator",
  "S-1-5-18": "Windows (SYSTEM)",
};

/**
 * Who a stop request is from: the account that owns the file. Hearth's services folder lets any
 * local account create a file that isn't there yet (it inherits BUILTIN\Users' "create files"
 * from C:\ProgramData), and a file stays its creator's, so the owner tells your requests and an
 * administrator's from anyone else's. One gap is left: LocalService, which install.ps1 lets
 * modify the folder for the services' logs, could rewrite a request you made without owning it.
 */
export function ownerOf(file: string): Promise<Asker> {
  if (process.platform !== "win32") {
    try {
      const { uid } = statSync(file);
      return Promise.resolve({
        trusted: uid === 0 || uid === process.getuid?.(),
        who: `uid ${uid}`,
      });
    } catch (err) {
      return Promise.resolve({ trusted: false, who: `an owner it couldn't read (${err})` });
    }
  }
  return new Promise((resolve) => {
    const env = { ...process.env, HEARTH_STOP_FILE: file };
    const args = ["-NoProfile", "-NonInteractive", "-Command", OWNER_SCRIPT];
    execFile(POWERSHELL, args, { env, timeout: 20_000, windowsHide: true }, (err, stdout) => {
      const [owner = "", me = ""] = String(stdout)
        .split(/\r?\n/)
        .map((l) => l.trim());
      if (err || !owner.startsWith("S-1-")) {
        resolve({
          trusted: false,
          who: `an owner Windows wouldn't say (${err?.message ?? owner})`,
        });
      } else if (owner === me) {
        resolve({ trusted: true, who: "Your account" });
      } else {
        resolve({ trusted: owner in ADMINS, who: ADMINS[owner] ?? `the account ${owner}` });
      }
    });
  });
}
