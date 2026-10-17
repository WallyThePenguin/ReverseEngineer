// Which copy of Hearth this is. A database restored into a dev copy carries the live install's
// records, tokens included, so what must happen in one place only checks this id instead: only
// the install that connected Jarvis's Slack bot listens on its socket, so a dev copy can't take
// the live events (D62). It lives in the data folder beside vault.key, never in the database, and
// backups don't take it (they take stored files and voice samples).
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const INSTALL_SERVICE = "install";

export interface Install {
  /** This install's id, made the first time it's asked for. */
  id(): string;
  /** Where you open this copy of Hearth, for a link to it from Slack (D62): HEARTH_ORIGIN. */
  origin?(): string;
}

/** Hearth's address as the server has it (apps/server/src/config.ts), without a trailing /. */
export const originOf = (env: NodeJS.ProcessEnv) =>
  (env.HEARTH_ORIGIN ?? `http://localhost:${env.HEARTH_PORT ?? 4400}`).replace(/\/$/, "");

function readId(file: string): string {
  const id = readFileSync(file, "utf8").trim();
  if (!id) throw new Error(`${file} is empty. Delete it and Nook makes a new one.`);
  return id;
}

function findId(env: NodeJS.ProcessEnv): string {
  const given = env.HEARTH_INSTALL_ID?.trim();
  if (given) return given;
  const file = join(env.HEARTH_DATA_DIR ?? process.cwd(), "install.id");
  if (existsSync(file)) return readId(file);
  mkdirSync(dirname(file), { recursive: true });
  const made = randomUUID();
  try {
    writeFileSync(file, made, { flag: "wx" });
    return made;
  } catch (err) {
    // Another Hearth process made it first.
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    return readId(file);
  }
}

/** HEARTH_INSTALL_ID, or install.id in the data folder, made the first time it's needed. */
export function installFromEnv(env: NodeJS.ProcessEnv = process.env): Install {
  let id: string | null = null;
  return {
    id() {
      id ??= findId(env);
      return id;
    },
    origin: () => originOf(env),
  };
}
