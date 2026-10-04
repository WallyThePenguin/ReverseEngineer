// How the Google, Slack and GitHub syncs are doing, as health components the worker reports every
// minute with the rest (sync.google, sync.slack, sync.github). Read from what each sync already
// records, its last error and when it last worked, so Settings and `hearth doctor` show a sync
// that's failing or has quietly stopped, and system.report tells you when one starts failing,
// whether or not Jarvis is running. Mail, Slack and GitHub save their own verdict (D55, D61),
// which is taken as it is; Google access and calendars keep only their last error, which counts
// as failing once it has lasted half an hour. A slowdown Google asked for isn't a failure (D55).
import { formatTime } from "@hearth/core";
import {
  calendar,
  githubAccount,
  googleAccount,
  mailAccount,
  setting,
  slackWorkspace,
} from "@hearth/db";
import { getSetting, type Kernel } from "@hearth/kernel";
import { roughly } from "@hearth/modules";
import { eq } from "drizzle-orm";
import type { HealthReport } from "./health.ts";

/** An error that has lasted this long, or a sync this quiet, is failing, not a blip. */
export const SYNC_FAILING_AFTER_MS = 30 * 60_000;

export interface SyncSource {
  /** What it is: an address, a calendar, a workspace, a GitHub login. */
  name: string;
  /** The last attempt's error, or null when it worked. */
  error: string | null;
  /** When the current run of errors began. */
  since?: Date | null;
  /** The sync's own verdict, or access only reconnecting can fix: failing at once. */
  failing?: boolean;
  /** When it last worked (or, for GitHub, last ran). */
  lastGood?: Date | null;
  /** Google asked Hearth to slow down until then. */
  pausedUntil?: Date | null;
}

type Status = HealthReport["status"];
const RANK: Record<Status, number> = { ok: 0, degraded: 1, failing: 2 };
const clip = (s: string) => (s.length > 300 ? `${s.slice(0, 299)}…` : s);

/** One component's report from its sources: the worst of them, each that isn't ok named. */
export function judgeSync(
  component: string,
  sources: SyncSource[],
  now: Date,
  timeZone: string,
): HealthReport {
  if (!sources.length) return { component, status: "ok", detail: "Not connected" };
  const notes: { status: Status; text: string }[] = [];
  for (const s of sources) {
    const error = s.error ? clip(s.error.replace(/\s+/g, " ").trim()) : null;
    const lasted = s.since ? now.getTime() - s.since.getTime() : 0;
    if (s.failing) notes.push({ status: "failing", text: `${s.name}: ${error ?? "failing"}` });
    else if (error && lasted >= SYNC_FAILING_AFTER_MS)
      notes.push({
        status: "failing",
        text: `${s.name}: failing for ${roughly(lasted)}: ${error}`,
      });
    else if (error)
      notes.push({ status: "degraded", text: `${s.name}: the last sync failed: ${error}` });
    else if (s.pausedUntil && s.pausedUntil > now)
      notes.push({
        status: "ok",
        text: `${s.name}: Google asked Hearth to slow down; resuming at ${formatTime(s.pausedUntil, timeZone)}`,
      });
    else if (s.lastGood && now.getTime() - s.lastGood.getTime() >= SYNC_FAILING_AFTER_MS)
      notes.push({
        status: "degraded",
        text: `${s.name}: last synced ${roughly(now.getTime() - s.lastGood.getTime())} ago`,
      });
  }
  const status = notes.reduce<Status>((w, n) => (RANK[n.status] > RANK[w] ? n.status : w), "ok");
  const count = sources.length === 1 ? sources[0]!.name : `${sources.length} connected`;
  const detail = notes.length ? notes.map((n) => n.text).join(" · ") : `Syncing (${count})`;
  return { component, status, detail };
}

/**
 * When each error run began, for syncs that only keep their latest error (Google access and
 * calendars). Kept in memory: after a restart a lasting error counts from then, so failing comes
 * half an hour later, never sooner.
 */
export class ErrorClock {
  private readonly started = new Map<string, Date>();
  since(key: string, error: string | null, now: Date): Date | null {
    if (!error) {
      this.started.delete(key);
      return null;
    }
    const at = this.started.get(key) ?? now;
    this.started.set(key, at);
    return at;
  }
}

async function google(kernel: Kernel, clock: ErrorClock, now: Date): Promise<SyncSource[]> {
  const out: SyncSource[] = [];
  for (const a of await kernel.db.select().from(googleAccount)) {
    // Mail and calendar say how they're doing below; this is the access they share.
    if (a.status === "ok") continue;
    out.push({
      name: a.email,
      error: a.lastError ?? `Google access is ${a.status}`,
      failing: a.status === "revoked",
      since: clock.since(`google:${a.email}`, a.lastError ?? a.status, now),
    });
  }
  for (const m of await kernel.db.select().from(mailAccount)) {
    // Mail judges itself (D55): failing only once its own state says so (access to reconnect, or
    // three failures with nothing synced for half an hour), so no `since` here. A pause Google
    // asked for is calm, even with an earlier error still on the row.
    const paused = m.syncState === "paused" && m.pausedUntil !== null && m.pausedUntil > now;
    out.push({
      name: `${m.address} mail`,
      error: paused ? null : m.lastError,
      failing: m.syncState === "failing",
      lastGood: m.syncState === "paused" ? null : m.syncedAt,
      pausedUntil: m.pausedUntil,
    });
  }
  for (const c of await kernel.db.select().from(calendar).where(eq(calendar.selected, true))) {
    out.push({
      name: `${c.title} calendar`,
      error: c.lastError,
      since: clock.since(`calendar:${c.id}`, c.lastError, now),
      lastGood: c.lastSyncedAt,
    });
  }
  return out;
}

// Slack and GitHub judge themselves too (D61): failing once their own state says so (a token that
// stopped working, something that won't pass by itself, or three failures with nothing read for
// half an hour). An error a round read past is worth a look, however long it has gone on.
async function slack(kernel: Kernel): Promise<SyncSource[]> {
  const rows = await kernel.db.select().from(slackWorkspace);
  return rows.map((w) => ({
    name: w.teamName,
    error: w.lastError,
    failing: w.syncState !== "ok",
    lastGood: w.syncedAt,
  }));
}

async function github(kernel: Kernel): Promise<SyncSource[]> {
  const rows = await kernel.db.select().from(githubAccount);
  return rows.map((a) => ({
    name: a.login,
    error: a.lastError,
    failing: a.syncState !== "ok",
    lastGood: a.syncedAt,
  }));
}

const SOURCES = { "sync.google": google, "sync.slack": slack, "sync.github": github } as const;

/**
 * The syncs' reports. One that isn't connected is left out, unless it reported before (it was
 * disconnected): then it says so, which also closes a failing report.
 */
export async function checkSyncs(kernel: Kernel, clock: ErrorClock): Promise<HealthReport[]> {
  const now = kernel.clock.now();
  const { timeZone } = await getSetting(kernel.db, "owner.dayRules");
  const reports: HealthReport[] = [];
  for (const [component, read] of Object.entries(SOURCES)) {
    const sources = await read(kernel, clock, now);
    if (!sources.length) {
      const [before] = await kernel.db
        .select({ key: setting.key })
        .from(setting)
        .where(eq(setting.key, `health.${component}`));
      if (!before) continue;
    }
    reports.push(judgeSync(component, sources, now, timeZone));
  }
  return reports;
}
