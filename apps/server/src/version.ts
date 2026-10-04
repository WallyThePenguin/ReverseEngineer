// Which build this is: the web build's dist/version.json (scripts/version-stamp.ts). The server
// reads it once, when it starts, so what it reports is what it started with: after an update, a
// server still saying the old commit wasn't restarted.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface VersionStamp {
  sha: string | null;
  builtAt: string;
  migrations: string[];
}

/** The stamp in a web build folder, or null when there's no build or it predates stamping. */
export function readVersionStamp(webDist: string | null): VersionStamp | null {
  if (!webDist) return null;
  try {
    const v = JSON.parse(readFileSync(join(webDist, "version.json"), "utf8")) as VersionStamp;
    if (typeof v.builtAt !== "string" || !Array.isArray(v.migrations)) return null;
    return {
      sha: typeof v.sha === "string" ? v.sha : null,
      builtAt: v.builtAt,
      migrations: v.migrations,
    };
  } catch {
    return null;
  }
}

/** The one string that names a build (scripts/version-stamp.ts has the same). */
export const buildId = (stamp: VersionStamp) => stamp.sha ?? stamp.builtAt;
