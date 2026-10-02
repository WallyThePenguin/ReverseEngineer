// Typed settings with defaults. Stored as JSON rows in the setting table.
import { type DayRules, DEFAULT_DAY_RULES, DEFAULT_SITE_RULES, type SiteRules } from "@hearth/core";
import { type DbOrTx, setting } from "@hearth/db";
import { eq } from "drizzle-orm";

export interface Settings {
  /** Stops all proactive work. Jarvis still answers when you talk to it. */
  "jarvis.paused": boolean;
  /** Proactive model turns per local day. Reactive turns are counted but never blocked. */
  "jarvis.proactiveTurnsPerDay": number;
  "owner.dayRules": DayRules;
  "owner.maxInterruptsPerDay": number;
  /** Warn about a task this many hours before it's due. */
  "tasks.dueSoonHours": number;
  /** Where Jarvis's browser may and may not go (D25). */
  "browser.sites": SiteRules;
  /** The Hearth extension's pairing code, hashed. Null until you connect Chrome. */
  "browser.pairing": { hash: string; createdAt: string } | null;
}

export const SETTING_DEFAULTS: Settings = {
  "jarvis.paused": false,
  "jarvis.proactiveTurnsPerDay": 60,
  "owner.dayRules": DEFAULT_DAY_RULES,
  "owner.maxInterruptsPerDay": 8,
  "tasks.dueSoonHours": 24,
  "browser.sites": DEFAULT_SITE_RULES,
  "browser.pairing": null,
};

export async function getSetting<K extends keyof Settings>(
  db: DbOrTx,
  key: K,
): Promise<Settings[K]> {
  const [row] = await db.select().from(setting).where(eq(setting.key, key));
  return row ? (row.value as Settings[K]) : SETTING_DEFAULTS[key];
}

export async function setSetting<K extends keyof Settings>(
  db: DbOrTx,
  key: K,
  value: Settings[K],
): Promise<void> {
  // Null clears the setting (the column can't hold SQL null), which reads back as its default.
  if (value === null) {
    await db.delete(setting).where(eq(setting.key, key));
    return;
  }
  await db
    .insert(setting)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: setting.key, set: { value, updatedAt: new Date() } });
}
