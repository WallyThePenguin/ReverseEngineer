// `hearth doctor`: checks everything Hearth needs and says how to fix what's wrong.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { credential, type Database, loadMigrations, setting } from "@hearth/db";
import { findChrome, loadLaunchConfig } from "@hearth/server";
import { like } from "drizzle-orm";
import { type Runner, runProgram } from "./backup.ts";

export type Mark = "ok" | "warn" | "fail";

export interface Check {
  name: string;
  mark: Mark;
  detail: string;
}

const SYMBOL: Record<Mark, string> = { ok: "✓", warn: "!", fail: "✗" };

export function formatChecks(checks: Check[]): string {
  return checks.map((c) => `${SYMBOL[c.mark]} ${c.name.padEnd(14)} ${c.detail}`).join("\n");
}

export function checkNode(version = process.versions.node): Check {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  const ok = major > 22 || (major === 22 && minor >= 18);
  return {
    name: "Node",
    mark: ok ? (major >= 24 ? "ok" : "warn") : "fail",
    detail: ok
      ? major >= 24
        ? `v${version}`
        : `v${version} works; Node 24 LTS is recommended`
      : `v${version} is too old. Install Node 24 LTS.`,
  };
}

/** Jarvis runs on your Claude Code login (or an API key if you set one). Never reads the file. */
export function checkClaudeLogin(env: NodeJS.ProcessEnv = process.env): Check {
  if (env.ANTHROPIC_API_KEY)
    return { name: "Claude", mark: "ok", detail: "Using ANTHROPIC_API_KEY" };
  const dir = env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  if (existsSync(join(dir, ".credentials.json")) || process.platform === "darwin") {
    return { name: "Claude", mark: "ok", detail: "Claude Code login found" };
  }
  return {
    name: "Claude",
    mark: "warn",
    detail: "No Claude login found. Run `claude` once and sign in with your Claude account.",
  };
}

export function checkOrigin(env: NodeJS.ProcessEnv = process.env): Check {
  const origin = env.HEARTH_ORIGIN;
  if (!origin) {
    return {
      name: "Address",
      mark: "warn",
      detail:
        "HEARTH_ORIGIN isn't set, so passkeys only work on this PC. Set it to your Tailscale address.",
    };
  }
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (!origin.startsWith("https://") && !local) {
    return {
      name: "Address",
      mark: "fail",
      detail: `${origin} must be https (Tailscale Serve provides it).`,
    };
  }
  return { name: "Address", mark: "ok", detail: origin };
}

/** pg_dump always; restic and rclone once off-site backups are configured. */
export async function checkBackupTools(
  env: NodeJS.ProcessEnv = process.env,
  run: Runner = runProgram,
): Promise<Check[]> {
  const has = async (cmd: string) => (await run(cmd, ["--version"])).code === 0;
  const checks: Check[] = [];
  checks.push(
    (await has("pg_dump"))
      ? { name: "pg_dump", mark: "ok", detail: "Found" }
      : {
          name: "pg_dump",
          mark: "fail",
          detail: "Not on PATH. Add PostgreSQL's bin folder to PATH.",
        },
  );
  const repo = env.HEARTH_BACKUP_REPOSITORY;
  if (!repo) {
    checks.push({
      name: "Off-site",
      mark: "warn",
      detail: "Backups stay on this PC. Set HEARTH_BACKUP_REPOSITORY to use Google Drive.",
    });
    return checks;
  }
  const WINGET: Record<string, string> = { restic: "restic.restic", rclone: "Rclone.Rclone" };
  for (const tool of repo.startsWith("rclone:") ? ["restic", "rclone"] : ["restic"]) {
    checks.push(
      (await has(tool))
        ? { name: tool, mark: "ok", detail: "Found" }
        : {
            name: tool,
            mark: "fail",
            detail: `Not on PATH, so backups can't upload. Install it (winget install ${WINGET[tool]}).`,
          },
    );
  }
  if (!env.RESTIC_PASSWORD_FILE && !env.RESTIC_PASSWORD) {
    checks.push({
      name: "restic key",
      mark: "fail",
      detail: "Set RESTIC_PASSWORD_FILE to the file holding your backup password.",
    });
  }
  return checks;
}

/** Whether Hearth can open Chrome by itself when Jarvis needs it (D28). */
export async function checkChrome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  run: Runner = runProgram,
): Promise<Check> {
  // As the server sees it when it runs as a service: on Windows, that means the task.
  const config = loadLaunchConfig({ ...env, HEARTH_AS_SERVICE: "1" }, platform);
  if (platform === "win32" && config.mode === "direct") config.mode = "task";
  if (config.mode === "off")
    return {
      name: "Chrome",
      mark: "ok",
      detail: "You open Chrome yourself (HEARTH_CHROME_LAUNCH=off)",
    };
  if (config.mode === "task") {
    const again = "Run ops\\windows\\install.ps1 again as administrator.";
    const query = await run("schtasks", ["/Query", "/TN", config.task, "/XML", "ONE"]);
    if (query.code !== 0)
      return {
        name: "Chrome",
        mark: "warn",
        detail: `No "${config.task}" task, so Hearth can't open Chrome by itself. ${again}`,
      };
    // Windows says the task ran even when the Chrome it points at is gone (reinstalled elsewhere).
    const command = /<Command>([^<]*)<\/Command>/
      .exec(query.stdout.replaceAll("\0", ""))?.[1]
      ?.replaceAll("&amp;", "&")
      .trim();
    // A name Windows wrote in another encoding can't be checked (U+FFFD where it didn't decode).
    if (command && !command.includes("\uFFFD") && !existsSync(command))
      return {
        name: "Chrome",
        mark: "warn",
        detail: `The "${config.task}" task opens ${command}, which isn't there anymore. ${again}`,
      };
    return { name: "Chrome", mark: "ok", detail: `Hearth opens it with the "${config.task}" task` };
  }
  const chrome = config.chromePath ?? findChrome(env, platform);
  return chrome && existsSync(chrome)
    ? { name: "Chrome", mark: "ok", detail: `Hearth opens ${chrome} when Jarvis needs it` }
    : {
        name: "Chrome",
        mark: "warn",
        detail: "Can't find Chrome, so Hearth can't open it by itself. Set HEARTH_CHROME_PATH.",
      };
}

export async function checkDatabase(database: Database): Promise<Check[]> {
  const checks: Check[] = [];
  try {
    await database.pool.query("SELECT 1");
    checks.push({ name: "Database", mark: "ok", detail: "Connected" });
  } catch (err) {
    return [{ name: "Database", mark: "fail", detail: `Can't connect: ${(err as Error).message}` }];
  }

  const known = loadMigrations().map((m) => m.name);
  const applied = await database.pool
    .query<{ name: string }>("SELECT name FROM _migration")
    .then((r) => new Set(r.rows.map((x) => x.name)))
    .catch(() => new Set<string>());
  const missing = known.filter((n) => !applied.has(n));
  checks.push(
    missing.length
      ? {
          name: "Migrations",
          mark: "fail",
          detail: `${missing.length} not applied. Run \`hearth migrate\`.`,
        }
      : { name: "Migrations", mark: "ok", detail: `${known.length} applied` },
  );
  if (missing.length) return checks;

  const passkeys = await database.db.select({ id: credential.id }).from(credential);
  checks.push(
    passkeys.length
      ? { name: "Login", mark: "ok", detail: `${passkeys.length} passkey(s)` }
      : { name: "Login", mark: "warn", detail: "No passkey yet. Run `hearth setup`." },
  );

  const health = await database.db.select().from(setting).where(like(setting.key, "health.%"));
  if (!health.some((h) => h.key === "health.backup")) {
    checks.push({
      name: "backup",
      mark: "warn",
      detail: "No backup has run yet. See docs/setup-windows.md.",
    });
  }
  for (const h of health) {
    const v = h.value as { status: string; detail: string };
    const mark: Mark = v.status === "ok" ? "ok" : v.status === "degraded" ? "warn" : "fail";
    checks.push({ name: h.key.slice("health.".length), mark, detail: v.detail || v.status });
  }
  return checks;
}
