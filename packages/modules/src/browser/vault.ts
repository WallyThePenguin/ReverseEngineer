// The sign-in vault (D26, D29): logins Jarvis may use, kept in Hearth's database with each
// password encrypted under a key that lives outside it. Only you add or change them, from
// Settings. Jarvis can see which sites and usernames there are, never a password: browser.sign_in
// decrypts one in code and types it straight into the matching site's password field.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type DbOrTx, vaultLogin } from "@hearth/db";
import { ActionError, defineAction, newId } from "@hearth/kernel";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { CALLERS } from "./access.ts";

export const VAULT_SERVICE = "vault";

/** Seals and opens passwords. Each is tied to its site and username, so it can't be moved. */
export class Vault {
  private key: Buffer | null = null;
  private readonly loadKey: () => Buffer;

  constructor(key: Buffer | (() => Buffer)) {
    this.loadKey = typeof key === "function" ? key : () => key;
  }

  private getKey(): Buffer {
    this.key ??= this.loadKey();
    if (this.key.length !== 32) throw new ActionError("failed", "The vault key isn't 32 bytes.");
    return this.key;
  }

  seal(site: string, username: string, password: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.getKey(), iv);
    cipher.setAAD(Buffer.from(`${site}\n${username}`));
    const body = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
    const parts = [iv, cipher.getAuthTag(), body].map((b) => b.toString("base64"));
    return `v1.${parts.join(".")}`;
  }

  open(site: string, username: string, sealed: string): string {
    const [v, iv, tag, body] = sealed.split(".");
    if (v !== "v1" || !iv || !tag || body === undefined)
      throw new ActionError("failed", "A saved sign-in is damaged. Save it again in Settings.");
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.getKey(), Buffer.from(iv, "base64"));
      decipher.setAAD(Buffer.from(`${site}\n${username}`));
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      const out = Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]);
      return out.toString("utf8");
    } catch {
      throw new ActionError(
        "failed",
        `The saved sign-in for ${site} can't be opened with this vault key. Save it again in Settings.`,
      );
    }
  }
}

/**
 * The vault key: HEARTH_VAULT_KEY (base64), or vault.key in the data folder, made the first
 * time a sign-in is saved. Backups of the database don't include it.
 */
export function vaultFromEnv(env: NodeJS.ProcessEnv = process.env): Vault {
  return new Vault(() => {
    if (env.HEARTH_VAULT_KEY) return Buffer.from(env.HEARTH_VAULT_KEY, "base64");
    const file = join(env.HEARTH_DATA_DIR ?? process.cwd(), "vault.key");
    if (existsSync(file)) return Buffer.from(readFileSync(file, "utf8").trim(), "base64");
    const key = randomBytes(32);
    mkdirSync(dirname(file), { recursive: true });
    try {
      writeFileSync(file, key.toString("base64"), { mode: 0o600, flag: "wx" });
      return key;
    } catch (err) {
      // Another Hearth process made it first.
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      return Buffer.from(readFileSync(file, "utf8").trim(), "base64");
    }
  });
}

/** "https://www.Example.com/login" or "example.com" → "www.example.com" / "example.com". */
export function siteOf(raw: string): string | null {
  const text = raw.trim().toLowerCase();
  try {
    const host = new URL(/^[a-z]+:\/\//.test(text) ? text : `https://${text}`).hostname;
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

export type VaultRow = typeof vaultLogin.$inferSelect;

/**
 * Whether a login saved for a site may be filled on a host: that exact host, with or without
 * "www.". Never other subdomains, which on many sites belong to other people (blogs, pages).
 */
export function fillsOn(site: string, host: string): boolean {
  const bare = (h: string) => h.toLowerCase().replace(/^www\./, "");
  return bare(site) === bare(host);
}

/** The saved logins that may be used on a host, most recently used first. */
export async function loginsFor(db: DbOrTx, host: string, username?: string): Promise<VaultRow[]> {
  const rows = await db.select().from(vaultLogin).orderBy(desc(vaultLogin.lastUsedAt));
  return rows.filter((r) => fillsOn(r.site, host) && (!username || r.username === username));
}

const site = z
  .string()
  .trim()
  .min(3)
  .max(253)
  .describe("The site's own address, like accounts.example.com. It's filled there only.");

export const vaultActions = [
  defineAction({
    name: "vault.logins",
    description:
      "The sites Pip can sign in to by itself (browser_sign_in), with their usernames. Passwords are never shown.",
    input: z.object({}),
    risk: "read",
    callers: CALLERS,
    async handler(_i, ctx) {
      const rows = await ctx.tx.select().from(vaultLogin).orderBy(vaultLogin.site);
      return rows.map((r) => ({
        id: r.id,
        site: r.site,
        username: r.username,
        lastUsedAt: r.lastUsedAt,
      }));
    },
  }),
  defineAction({
    name: "vault.save",
    description: "Save a sign-in Pip may use on one site, or change its password.",
    input: z.object({
      site,
      username: z.string().trim().min(1).max(300),
      password: z.string().min(1).max(1000),
    }),
    // Only you, from Settings; the audit log keeps none of it.
    risk: "secret",
    callers: ["owner"],
    async handler(i, ctx) {
      const host = siteOf(i.site);
      if (!host) throw new ActionError("invalid_input", `${i.site} isn't a site name.`);
      const vault = ctx.service<Vault>(VAULT_SERVICE);
      const secret = vault.seal(host, i.username, i.password);
      // A failed query's message carries its parameters; this one's stay out of the logs.
      const [row] = await ctx.tx
        .insert(vaultLogin)
        .values({ id: newId(), site: host, username: i.username, secret })
        .onConflictDoUpdate({
          target: [vaultLogin.site, vaultLogin.username],
          set: { secret, updatedAt: ctx.now },
        })
        .returning({ id: vaultLogin.id })
        .catch(() => {
          throw new ActionError("failed", "The sign-in couldn't be saved.");
        });
      ctx.emit({ kind: "vault.changed", payload: { site: host, username: i.username } });
      return { id: row!.id, site: host, username: i.username };
    },
  }),
  defineAction({
    name: "vault.remove",
    description: "Forget a saved sign-in.",
    input: z.object({ id: z.string().uuid() }),
    risk: "internal",
    callers: ["owner"],
    async handler(i, ctx) {
      const [row] = await ctx.tx
        .delete(vaultLogin)
        .where(eq(vaultLogin.id, i.id))
        .returning({ site: vaultLogin.site, username: vaultLogin.username });
      if (!row) throw new ActionError("not_found", "No saved sign-in with that id.");
      ctx.emit({ kind: "vault.changed", payload: { ...row, removed: true } });
      return { removed: true };
    },
  }),
];
