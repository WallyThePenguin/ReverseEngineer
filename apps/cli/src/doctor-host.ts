// `hearth doctor`, the running install: Windows' view of the services and Jarvis's task, whether
// the server answers and which build it runs, whether that's the code on disk, Tailscale Serve,
// and free space on every drive Hearth uses (C: included: Node, Chrome and the Claude login).
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type DeepHealth, readVersionStamp } from "@hearth/server";
import { checkDrives, hearthFolders } from "@hearth/worker";
import type { Runner } from "./backup.ts";
import type { Check, Mark } from "./doctor.ts";

const MARK = { ok: "ok", degraded: "warn", failing: "fail" } as const satisfies Record<
  string,
  Mark
>;
const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "?");
const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";

/** Each service's or task's state as Windows names it (Running, Stopped, Ready...), null if none. */
const STATES = [
  "$ErrorActionPreference = 'SilentlyContinue'; $s = [ordered]@{}",
  "foreach ($n in 'hearth-server', 'hearth-worker') { $x = Get-Service -Name $n; $s[$n] = if ($x) { [string]$x.Status } else { $null } }",
  "foreach ($n in 'Hearth Jarvis', 'Hearth Chrome', 'Hearth backup') { $x = Get-ScheduledTask -TaskName $n; $s[$n] = if ($x) { [string]$x.State } else { $null } }",
  "$s | ConvertTo-Json -Compress",
].join("; ");

const DEVELOPING = "(fine while developing; see docs/setup-windows.md)";
const REINSTALL = "Run ops\\windows\\install.ps1 again as administrator.";

export function judgeService(name: string, state: string | null | undefined): Check {
  if (!state) return { name, mark: "warn", detail: `Not installed as a service ${DEVELOPING}` };
  if (state === "Running") return { name, mark: "ok", detail: "Running" };
  if (state === "Stopped") {
    const which = name.replace("hearth-", "");
    return { name, mark: "fail", detail: `Stopped. Start it: pnpm hearth restart ${which}` };
  }
  return { name, mark: "warn", detail: state };
}

/**
 * Jarvis's task must be running; Chrome's and the backup's only run now and then. Named apart from
 * the health components (jarvis, backup) and the Chrome check: update.ps1 tells a new failure
 * from an old one by name.
 */
export function judgeTask(task: string, state: string | null | undefined): Check {
  const what = task.replace("Hearth ", "");
  const name = `${what[0]!.toUpperCase()}${what.slice(1)} task`;
  const always = task === "Hearth Jarvis";
  if (!state) return { name, mark: "warn", detail: `No "${task}" task ${DEVELOPING}` };
  if (state === "Disabled") return { name, mark: "fail", detail: `Disabled. ${REINSTALL}` };
  if (state === "Running") return { name, mark: "ok", detail: "Running" };
  if (state === "Ready" && !always) return { name, mark: "ok", detail: "Ready" };
  if (state === "Ready")
    return {
      name,
      mark: "fail",
      detail: "Not running, so Jarvis is off. Start it: pnpm hearth restart jarvis",
    };
  return { name, mark: "warn", detail: state };
}

/** Whether process `pid` is running on this PC. One this account may not signal still is. */
export function pidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The Jarvis task idle while a Jarvis still checks in (every 30 seconds) and its process is still
 * there: one that outlived its task's stop, still on the code it started with (D63). While it
 * holds its log, each start of the task fails at once, so `hearth restart jarvis` can't help;
 * only an administrator can end it.
 */
export function judgeJarvisTask(
  task: Check,
  report: DeepHealth | null,
  now = new Date(),
  running: (pid: number) => boolean = pidRunning,
): Check {
  const alive = report?.jarvisAlive;
  if (task.name !== "Jarvis task" || !task.detail.startsWith("Not running") || !alive) return task;
  if (now.getTime() - new Date(alive.at).getTime() > 2 * 60_000) return task;
  // Checked in lately, but gone since (it stopped, or crashed): nothing to name.
  if (!running(alive.pid)) return task;
  return {
    ...task,
    detail: `Not running, but a Jarvis it didn't start is (pid ${alive.pid}, since ${alive.since}), on the code it started with, and the task can't start another while it runs. Run taskkill /F /PID ${alive.pid} as administrator, then pnpm hearth restart jarvis`,
  };
}

/**
 * hearth-server, hearth-worker and the Jarvis, Chrome and backup tasks, as Windows sees them;
 * `installed` says whether the server is installed as a service (so it should be up).
 */
export async function checkServices(
  platform: NodeJS.Platform,
  run: Runner,
): Promise<{ checks: Check[]; installed: boolean }> {
  if (platform !== "win32") return { checks: [], installed: false };
  const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", STATES]);
  let states: Record<string, string | null>;
  try {
    states = JSON.parse(r.stdout) as Record<string, string | null>;
  } catch {
    const why = firstLine(r.stderr) || `exit ${r.code}`;
    const check: Check = {
      name: "Services",
      mark: "warn",
      detail: `Couldn't ask Windows about them: ${why}`,
    };
    return { checks: [check], installed: true };
  }
  const checks = [
    judgeService("hearth-server", states["hearth-server"]),
    judgeService("hearth-worker", states["hearth-worker"]),
    judgeTask("Hearth Jarvis", states["Hearth Jarvis"]),
    judgeTask("Hearth backup", states["Hearth backup"]),
  ];
  // The Chrome check already says whether that task is there; only say more when it's off.
  if (states["Hearth Chrome"] === "Disabled") checks.push(judgeTask("Hearth Chrome", "Disabled"));
  return { checks, installed: Boolean(states["hearth-server"]) };
}

/**
 * Asks the server itself, the way update.ps1 does: straight to it on this PC. Not answering is a
 * fail when it's installed as a service (it should be up), a warning while developing.
 */
export async function probeServer(
  env: NodeJS.ProcessEnv,
  fetchFn: typeof fetch = fetch,
  installed = true,
): Promise<{ check: Check; report: DeepHealth | null }> {
  const port = Number(env.HEARTH_PORT ?? 4400);
  const bound = env.HEARTH_HOST;
  const host = !bound || bound === "0.0.0.0" || bound === "::" ? "127.0.0.1" : bound;
  const base = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
  const name = "Server";
  try {
    const res = await fetchFn(`${base}/api/health/deep`, { signal: AbortSignal.timeout(5_000) });
    if (res.status === 200) {
      const report = (await res.json()) as DeepHealth;
      const build = report.sha ? `build ${short(report.sha)}` : "an unstamped build";
      const since = report.startedAt ? `, up since ${report.startedAt}` : "";
      return { check: { name, mark: "ok", detail: `Answers, running ${build}${since}` }, report };
    }
    const detail =
      res.status === 404
        ? "Answers, but it's from before deep health. Restart it: pnpm hearth restart server"
        : `Answers, but won't share its health (HTTP ${res.status})`;
    return { check: { name, mark: "warn", detail }, report: null };
  } catch {
    if (!installed)
      return { check: { name, mark: "warn", detail: `Not running at ${base}` }, report: null };
    const detail = `Not answering at ${base}. Start it: pnpm hearth restart server`;
    return { check: { name, mark: "fail", detail }, report: null };
  }
}

/** The Chrome extension's link, as the server sees it. */
export function checkChromeLink(report: DeepHealth | null): Check | null {
  const b = report?.browser;
  if (!b) return null;
  const name = "Chrome link";
  if (b.connected)
    return {
      name,
      mark: "ok",
      detail: `Extension ${b.version ?? "(no version)"} connected since ${b.since}`,
    };
  if (b.paired === false)
    return {
      name,
      mark: "warn",
      detail: "No extension is paired yet. See section 10 of docs/setup-windows.md.",
    };
  if (b.openError)
    return {
      name,
      mark: "warn",
      detail: `Not connected, and Hearth couldn't open Chrome: ${b.openError}`,
    };
  return {
    name,
    mark: "warn",
    detail: "The Hearth extension isn't connected. Hearth opens Chrome when Jarvis needs it.",
  };
}

/** The web build's stamp against the code on disk, and against what the server runs. */
export async function checkBuild(
  env: NodeJS.ProcessEnv,
  run: Runner,
  report: DeepHealth | null,
  root = process.cwd(),
): Promise<Check> {
  const name = "Build";
  const dist = resolve(root, env.HEARTH_WEB_DIST ?? join("apps", "web", "dist"));
  if (!existsSync(join(dist, "index.html")))
    return { name, mark: "warn", detail: `No web build in ${dist}. Run pnpm build:web.` };
  const stamp = readVersionStamp(dist);
  if (!stamp)
    return {
      name,
      mark: "warn",
      detail: "Built before builds were stamped. Run pnpm build:web.",
    };
  const git = await run("git", ["-C", root, "rev-parse", "HEAD"]);
  const head = git.code === 0 ? git.stdout.trim() : null;
  if (!head)
    return {
      name,
      mark: "warn",
      detail: `Built from ${short(stamp.sha)}; git can't say which commit the code is at.`,
    };
  if (stamp.sha !== head)
    return {
      name,
      mark: "fail",
      detail: `The web app was built from ${short(stamp.sha)}, but the code is at ${short(head)}. Run pnpm build:web, then pnpm hearth restart server.`,
    };
  if (report?.sha && report.sha !== head)
    return {
      name,
      mark: "fail",
      detail: `The server still runs ${short(report.sha)}, but the code is at ${short(head)}. Run pnpm hearth restart server.`,
    };
  const served = report?.sha ? ", and the server runs it" : "";
  return { name, mark: "ok", detail: `Built from ${short(head)} at ${stamp.builtAt}${served}` };
}

interface ServeConfig {
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  Foreground?: Record<string, ServeConfig>;
}

/** When Hearth's address is on a tailnet: is Tailscale Serve passing it to Hearth? */
export async function checkTailscale(env: NodeJS.ProcessEnv, run: Runner): Promise<Check | null> {
  let url: URL;
  try {
    url = new URL(env.HEARTH_ORIGIN ?? "");
  } catch {
    return null;
  }
  if (!url.hostname.endsWith(".ts.net")) return null;
  const name = "Tailscale";
  const port = Number(env.HEARTH_PORT ?? 4400);
  const fix =
    url.port && url.port !== "443"
      ? `tailscale serve --bg --https=${url.port} ${port}`
      : `tailscale serve --bg ${port}`;
  const r = await run("tailscale", ["serve", "status", "--json"]);
  if (r.code === 127)
    return {
      name,
      mark: "fail",
      detail: "Not installed or not on PATH, so your devices can't reach Hearth.",
    };
  let cfg: ServeConfig;
  try {
    if (r.code !== 0) throw new Error();
    cfg = JSON.parse(r.stdout || "{}") as ServeConfig;
  } catch {
    const why = firstLine(r.stderr) || `exit ${r.code}`;
    return { name, mark: "fail", detail: `Didn't answer (${why}). Is it running and signed in?` };
  }
  const webs = [cfg.Web ?? {}, ...Object.values(cfg.Foreground ?? {}).map((f) => f.Web ?? {})];
  const key = `${url.hostname}:${url.port || "443"}`;
  const handlers = webs.flatMap((w) => Object.values(w[key]?.Handlers ?? {}));
  if (!handlers.length)
    return { name, mark: "fail", detail: `Not serving ${url.origin}. Run: ${fix}` };
  const proxies = handlers.map((h) => h.Proxy ?? "").filter(Boolean);
  const hearth = new RegExp(`^(https?://)?(127\\.0\\.0\\.1|localhost):${port}(/|$)`);
  if (!proxies.some((p) => hearth.test(p)))
    return {
      name,
      mark: "fail",
      detail: `Serves ${url.origin} from ${proxies.join(", ") || "something else"}, not Hearth on port ${port}. Run: ${fix}`,
    };
  return { name, mark: "ok", detail: `Serves ${url.origin} from 127.0.0.1:${port}` };
}

/** Free space on each drive Hearth, Chrome and the Claude login live on. */
export async function checkDiskSpace(env: NodeJS.ProcessEnv): Promise<Check[]> {
  const folders = [...hearthFolders(env.HEARTH_DATA_DIR ?? process.cwd(), env), homedir()];
  if (env.LOCALAPPDATA) folders.push(join(env.LOCALAPPDATA, "Google", "Chrome", "User Data"));
  const drives = await checkDrives(folders);
  return drives.map((d) => ({
    name: `Disk ${d.drive}`,
    mark: MARK[d.status],
    detail:
      d.status === "ok"
        ? d.detail
        : `${d.detail}. Free up space: Hearth, Chrome and Jarvis fail when it runs out.`,
  }));
}
