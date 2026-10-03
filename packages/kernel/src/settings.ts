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
  /** Earlier pairing codes, hashed, newest first: an extension with one needs pairing again. */
  "browser.oldPairings": string[];
  /** Seconds Jarvis waits between steps on the same site, so sites don't take it for a bot. */
  "browser.pace": { seconds: number; sites: Record<string, number> };
  /** Tasks estimated at this many minutes or more get time blocked on your calendar. */
  "calendar.blockMinMinutes": number;
  /** Prep packets are made for events with guests, or at least this long, in the next 48 hours. */
  "calendar.prepMinMinutes": number;
  /** How dictation is written in each app: the first whose match is in the app or window. */
  "voice.styles": { name: string; match: string; instructions: string }[];
  /** The key pair phone notifications are signed with, made the first time one is turned on. */
  "push.vapid": { publicKey: string; privateKey: string } | null;
}

export const SETTING_DEFAULTS: Settings = {
  "jarvis.paused": false,
  "jarvis.proactiveTurnsPerDay": 60,
  "owner.dayRules": DEFAULT_DAY_RULES,
  "owner.maxInterruptsPerDay": 8,
  "tasks.dueSoonHours": 24,
  "browser.sites": DEFAULT_SITE_RULES,
  "browser.pairing": null,
  "browser.oldPairings": [],
  "browser.pace": { seconds: 2, sites: {} },
  "calendar.blockMinMinutes": 60,
  "calendar.prepMinMinutes": 30,
  "voice.styles": [
    { name: "Chat", match: "slack", instructions: "Casual and short. No greeting or sign-off." },
    { name: "Email", match: "gmail", instructions: "Clear, friendly full sentences." },
  ],
  "push.vapid": null,
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
