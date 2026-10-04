// What a build is: the commit it came from, when it was built, and the database migrations that
// code expects. The web build writes it to dist/version.json (apps/web/vite.config.ts); the
// server reports it at /api/health/deep, `hearth doctor` compares it with the code, and
// ops/windows/update.ps1 won't call an update done until the server says it's running it.

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

export interface VersionStamp {
  /** The git commit, or null when git can't say (a copy without .git). */
  sha: string | null;
  builtAt: string;
  /** Migration names, oldest first. */
  migrations: string[];
}

export function gitSha(root: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
    return /^[0-9a-f]{40}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

export function versionStamp(root: string, now = new Date()): VersionStamp {
  const migrations = readdirSync(join(root, "packages", "db", "migrations"))
    .filter((f) => f.endsWith(".up.sql"))
    .map((f) => f.slice(0, -".up.sql".length))
    .sort();
  return { sha: gitSha(root), builtAt: now.toISOString(), migrations };
}

/** The one string that names a build: its commit, or when it was built if there's no commit. */
export const buildId = (stamp: VersionStamp) => stamp.sha ?? stamp.builtAt;
