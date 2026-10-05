// CI runs on the owner's PC, which is also the live Hearth's (D66). A self-hosted job runs this
// first, and again at the top of every step that starts a server, takes a backup or restores
// one. It exits 1, naming each problem, unless everything the job could reach is CI's own: its
// Postgres (5499, never the live 5432), a database named for this run, ports 4480-4499 (never
// 4400 or 4443), folders under the runner's temp folder, an empty rclone config (the owner's
// lists Google Drive), no .env, and no Chrome but Playwright's. Hearth's own defaults point at
// the live install (port 4400, localhost:5432/hearth, the working folder), so every one of them
// must be set, not just left alone.
//
// These are the rules; guard.ts runs them, always, as `node ops/ci-runner/guard.ts`.
import { existsSync, readFileSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";

/** What the guard asks of the machine, so tests can describe one. */
export interface Host {
  platform: NodeJS.Platform;
  exists(path: string): boolean;
  /** A file's size in bytes, or null when there's no such file. */
  fileSize(path: string): number | null;
  /** /proc/self/mountinfo on Linux. */
  mounts(): string;
}

export const CI_PORTS = { from: 4480, to: 4499 } as const;
export const CI_DB_PORT = 5499;
/** Where the live Hearth keeps its code, data, logs and services' files on the PC. */
export const LIVE_DIRS = ["D:\\Hearth", "C:\\ProgramData\\Hearth"];
/** The Windows runner, its work folder and its caches all live here. */
export const WINDOWS_CI_ROOT = "D:\\hearth-ci";
const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** Bind mounts of Windows drives into a Docker Desktop container show up as one of these. */
const HOST_MOUNT = /\s-\s(9p|drvfs|fakeowner|virtiofs|fuse\.grpcfuse)\s|\/mnt\/host\//;

export const realHost: Host = {
  platform: process.platform,
  exists: existsSync,
  fileSize: (path) => {
    try {
      const s = statSync(path);
      return s.isFile() ? s.size : null;
    } catch {
      return null;
    }
  },
  mounts: () => {
    try {
      return readFileSync("/proc/self/mountinfo", "utf8");
    } catch {
      return "";
    }
  },
};

/** The per-run database prefix: hearth_ci_<run id>_<attempt>. */
export function runDatabase(env: NodeJS.ProcessEnv): string | null {
  const id = env.GITHUB_RUN_ID ?? "";
  const attempt = env.GITHUB_RUN_ATTEMPT ?? "";
  return /^\d+$/.test(id) && /^\d+$/.test(attempt) ? `hearth_ci_${id}_${attempt}` : null;
}

/** A URL with its password replaced, for messages. */
function shown(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "(not a URL)";
  }
}

export function check(env: NodeJS.ProcessEnv, host: Host = realHost): string[] {
  const problems: string[] = [];
  const windows = host.platform === "win32";
  const paths = windows ? win32 : posix;
  const inside = (child: string, parent: string) => {
    const rel = paths.relative(paths.resolve(parent), paths.resolve(child));
    return rel === "" || (rel.split(/[\\/]/)[0] !== ".." && !paths.isAbsolute(rel));
  };

  // The runner's own folders, which everything else is checked against.
  const temp = env.RUNNER_TEMP;
  const workspace = env.GITHUB_WORKSPACE;
  if (!temp) problems.push("RUNNER_TEMP isn't set: run this as a step of a GitHub Actions job.");
  if (!workspace) problems.push("GITHUB_WORKSPACE isn't set: run this inside a job.");
  const db = runDatabase(env);
  if (!db)
    problems.push(
      "GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT must be set (they name the run's database).",
    );

  if (windows) {
    for (const [name, dir] of [
      ["GITHUB_WORKSPACE", workspace],
      ["RUNNER_TEMP", temp],
    ] as const) {
      if (!dir) continue;
      if (!inside(dir, WINDOWS_CI_ROOT))
        problems.push(
          `${name} is ${dir}, outside ${WINDOWS_CI_ROOT}: this isn't the Hearth CI runner.`,
        );
      for (const live of LIVE_DIRS)
        if (inside(dir, live) || inside(live, dir))
          problems.push(`${name} is ${dir}, which overlaps the live Hearth's ${live}.`);
    }
  } else {
    // The Linux runner is a container with no way out to the PC's drives or Docker.
    if (!host.exists("/.dockerenv"))
      problems.push(
        "Not inside a container: the Linux CI jobs run only in the hearth-ci-linux container.",
      );
    for (const sock of ["/var/run/docker.sock", "/run/docker.sock"])
      if (host.exists(sock))
        problems.push(`${sock} is here: the CI container must not reach Docker.`);
    const mounted = host
      .mounts()
      .split("\n")
      .filter((line) => HOST_MOUNT.test(line));
    for (const line of mounted)
      problems.push(
        `A drive of the PC is mounted in the container (${line.split(" ")[4] ?? line}).`,
      );
  }

  // Node loads .env for `pnpm hearth` (--env-file-if-exists). A checkout in the live Hearth's
  // folder is refused above, without looking at its .env.
  const live = windows && !!workspace && LIVE_DIRS.some((dir) => inside(workspace, dir));
  if (workspace && !live && host.exists(paths.join(workspace, ".env")))
    problems.push(`${paths.join(workspace, ".env")} exists: CI never reads a .env. Delete it.`);

  // Databases: Hearth's defaults are the live cluster (localhost:5432).
  const local5499 = (name: string, raw: string | undefined, allowed: (d: string) => boolean) => {
    if (!raw) {
      problems.push(`${name} isn't set, so Hearth would use the live database (localhost:5432).`);
      return;
    }
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      problems.push(`${name} isn't a URL.`);
      return;
    }
    if (u.protocol !== "postgres:" && u.protocol !== "postgresql:")
      problems.push(`${name} isn't a postgres:// URL.`);
    if (!LOCAL.has(u.hostname))
      problems.push(`${name} (${shown(raw)}) must be on this machine (localhost or 127.0.0.1).`);
    if (u.port !== String(CI_DB_PORT))
      problems.push(
        `${name} (${shown(raw)}) must name port ${CI_DB_PORT}, CI's Postgres${u.port === "5432" || !u.port ? "; 5432 is the live Hearth's" : ""}.`,
      );
    // libpq and node-postgres both take host=, port= and service= from the query.
    if (u.search)
      problems.push(`${name} (${shown(raw)}) can't have a query: it could move the host or port.`);
    const database = decodeURIComponent(u.pathname.slice(1));
    if (!allowed(database))
      problems.push(
        `${name} names the database "${database}"; CI's are named ${db ?? "hearth_ci_<run>_<attempt>"}.`,
      );
  };
  const perRun = (d: string) => !!db && (d === db || d.startsWith(`${db}_`));
  local5499("HEARTH_DATABASE_URL", env.HEARTH_DATABASE_URL, perRun);
  local5499(
    "HEARTH_TEST_DATABASE_URL",
    env.HEARTH_TEST_DATABASE_URL,
    (d) => d === "postgres" || perRun(d),
  );
  // psql, pg_dump and pg_restore without a URL go to PGHOST:PGPORT, else localhost:5432.
  if (!env.PGHOST || !LOCAL.has(env.PGHOST))
    problems.push(`PGHOST must be set to 127.0.0.1 or localhost (it's ${env.PGHOST ?? "unset"}).`);
  if (env.PGPORT !== String(CI_DB_PORT))
    problems.push(
      `PGPORT must be ${CI_DB_PORT}, CI's Postgres (it's ${env.PGPORT ?? "unset, so 5432"}).`,
    );
  for (const name of ["PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE"])
    if (env[name]) problems.push(`${name} is set: it could point the Postgres tools elsewhere.`);

  // Ports: Hearth's default is 4400, the live server's; Tailscale serves it on 4443.
  const ciPort = (p: number) => Number.isInteger(p) && p >= CI_PORTS.from && p <= CI_PORTS.to;
  const range = `${CI_PORTS.from}-${CI_PORTS.to}`;
  if (!env.HEARTH_PORT)
    problems.push(`HEARTH_PORT isn't set, so a server would take 4400, the live Hearth's port.`);
  else if (!ciPort(Number(env.HEARTH_PORT)))
    problems.push(
      `HEARTH_PORT is ${env.HEARTH_PORT}; CI's ports are ${range} (4400 and 4443 are the live Hearth's).`,
    );
  // The end-to-end tests' defaults: http://localhost:4400 to drive, 4404 or 4690 for a server of
  // their own (apps/web/e2e).
  if (!env.HEARTH_E2E_PORT)
    problems.push(
      `HEARTH_E2E_PORT isn't set, so an end-to-end test's own server would take 4404 or 4690, outside ${range}.`,
    );
  else if (!ciPort(Number(env.HEARTH_E2E_PORT)))
    problems.push(`HEARTH_E2E_PORT is ${env.HEARTH_E2E_PORT}; CI's ports are ${range}.`);
  if (!env.HEARTH_E2E_URL)
    problems.push(
      "HEARTH_E2E_URL isn't set, so the end-to-end tests would drive http://localhost:4400, the live Hearth.",
    );
  if (env.HEARTH_HOST && !LOCAL.has(env.HEARTH_HOST) && env.HEARTH_HOST !== "::1")
    problems.push(`HEARTH_HOST is ${env.HEARTH_HOST}: CI servers listen on loopback only.`);
  const origins = ["HEARTH_ORIGIN", "HEARTH_LOCAL_ORIGIN", "HEARTH_E2E_URL"];
  if (!env.HEARTH_ORIGIN)
    problems.push("HEARTH_ORIGIN isn't set (it's http://localhost:<CI port>).");
  for (const name of origins) {
    const raw = env[name];
    if (!raw) continue;
    let u: URL | null = null;
    try {
      u = new URL(raw);
    } catch {}
    if (!u || !LOCAL.has(u.hostname) || !ciPort(Number(u.port)))
      problems.push(`${name} is ${raw}; CI's addresses are http://localhost:<${range}>.`);
  }

  // Folders: the CLI's defaults are the working folder, and backups go off-site through rclone.
  const underTemp = (name: string, required: boolean) => {
    const value = env[name];
    if (!value) {
      if (required) problems.push(`${name} isn't set; CI keeps it under RUNNER_TEMP.`);
      return;
    }
    if (/^[a-z][a-z0-9+.-]+:/i.test(value) && !/^[a-z]:[\\/]/i.test(value))
      problems.push(
        `${name} is ${value}: CI's backups stay in a local folder, never ${value.split(":")[0]}:.`,
      );
    else if (temp && !inside(value, temp))
      problems.push(`${name} is ${value}, outside RUNNER_TEMP (${temp}).`);
  };
  for (const name of ["HEARTH_DATA_DIR", "HEARTH_BACKUP_DIR", "RESTIC_CACHE_DIR", "RCLONE_CONFIG"])
    underTemp(name, true);
  for (const name of [
    "HEARTH_BACKUP_REPOSITORY",
    "RESTIC_REPOSITORY",
    "RESTIC_REPOSITORY_FILE",
    "RESTIC_PASSWORD_FILE",
    "HEARTH_E2E_PROFILE",
  ])
    underTemp(name, false);
  // Only CI's own file is looked at: the owner's (%APPDATA%\rclone) is refused above, unread.
  const rclone = env.RCLONE_CONFIG;
  if (rclone && temp && inside(rclone, temp) && host.fileSize(rclone) !== 0)
    problems.push(
      `RCLONE_CONFIG (${env.RCLONE_CONFIG}) must be an empty file, so rclone knows no remotes.`,
    );
  for (const name of Object.keys(env))
    if (/^RCLONE_/i.test(name) && name !== "RCLONE_CONFIG")
      problems.push(`${name} is set: rclone could reach a remote with it.`);
  if (env.RESTIC_PASSWORD_COMMAND)
    problems.push("RESTIC_PASSWORD_COMMAND is set: CI's password is a throwaway.");
  if (env.RESTIC_PASSWORD && !env.RESTIC_PASSWORD.startsWith("ci-"))
    problems.push(
      "RESTIC_PASSWORD doesn't start with ci-: CI's restic password is a throwaway, never the real one.",
    );
  if (env.HEARTH_VAULT_KEY)
    problems.push("HEARTH_VAULT_KEY is set: CI never has the real vault key.");

  // Chrome: the owner's, in the owner's profile, is Hearth's default when it isn't a service.
  const launch = env.HEARTH_CHROME_LAUNCH;
  const profile = /--user-data-dir=("?)([^"\s]+)\1/.exec(env.HEARTH_CHROME_ARGS ?? "")?.[2];
  const playwright = /[\\/]ms-playwright[\\/]/.test(env.HEARTH_CHROME_PATH ?? "");
  const tempProfile = !!profile && !!temp && inside(profile, temp);
  if (launch === "direct" && !windows && playwright && tempProfile) {
    // The Linux chrome-launch step: Playwright's Chromium, in a profile under RUNNER_TEMP.
  } else if (launch !== "off") {
    problems.push(
      windows || launch !== "direct"
        ? `HEARTH_CHROME_LAUNCH is ${launch ?? "unset"}; CI sets it to off, so Hearth never opens the owner's Chrome.`
        : "HEARTH_CHROME_LAUNCH=direct needs HEARTH_CHROME_PATH in ms-playwright and --user-data-dir under RUNNER_TEMP.",
    );
  }
  if (env.HEARTH_AS_SERVICE === "1")
    problems.push(
      "HEARTH_AS_SERVICE=1 is the live services' setting (the Jarvis task, C:\\ProgramData\\Hearth).",
    );

  return problems;
}

export function main(env: NodeJS.ProcessEnv = process.env, host: Host = realHost): number {
  const problems = check(env, host);
  if (problems.length) {
    console.error("CI guard: not running here, because this PC is also the live Hearth's (D66):");
    for (const p of problems)
      console.error(env.GITHUB_ACTIONS === "true" ? `::error::${p}` : `  - ${p}`);
    return 1;
  }
  console.log(
    `CI guard: ok. Database ${shown(env.HEARTH_DATABASE_URL ?? "")}, port ${env.HEARTH_PORT}, files under ${env.RUNNER_TEMP}.`,
  );
  return 0;
}
