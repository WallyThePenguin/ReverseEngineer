// Hearth's own failures go to the inbox straight from the report that says so, in the same
// transaction. They used to go through a reflex, which only the Jarvis process runs, so with
// Jarvis stopped nothing else could tell you either. They're interrupts, so they reach your
// phone: inside the day's budget, and held through quiet hours until the morning (a backup that
// fails at 2 a.m. buzzes at breakfast, not at 2 a.m.).
import { localDate } from "@hearth/core";
import { type ActionContext, createNotification, getSetting } from "@hearth/kernel";

/** How a component is named in an alert; others go by their own name. */
const LABELS: Readonly<Record<string, string>> = {
  "sync.google": "Google sync",
  "sync.slack": "Slack sync",
  "sync.github": "GitHub sync",
  "sync.notion": "Notion sync",
  "sync.slack_bot": "Jarvis's Slack bot",
  worker: "Hearth's worker",
  server: "Hearth's server",
  disk: "Disk space",
  // The worker reports it failing when no backup has run for a day and a half.
  backup: "The nightly backup",
  schedules: "Scheduling",
  browser: "The Chrome link",
};

export const componentLabel = (component: string) => LABELS[component] ?? component;

type AlertContext = Pick<ActionContext, "tx" | "now" | "caller" | "emit">;

/** The owner's calendar day, so an evening failure and the next morning's are told apart. */
async function today(ctx: AlertContext) {
  const { timeZone } = await getSetting(ctx.tx, "owner.dayRules");
  return localDate(ctx.now, timeZone);
}

/**
 * Tells you a component started failing: once a day per component, so a flapping one doesn't
 * fill the inbox. Jarvis raises its own, worded per outage (D54).
 */
export async function alertFailing(ctx: AlertContext, component: string, detail: string) {
  if (component === "jarvis") return;
  await createNotification(ctx, {
    kind: "system.alert",
    title: `${componentLabel(component)} is failing`,
    body: detail,
    urgency: "interrupt",
    dedupeKey: `failing:${component}:${await today(ctx)}`,
  });
}

export async function alertBackupFailed(ctx: AlertContext, detail: string) {
  await createNotification(ctx, {
    kind: "system.alert",
    title: "Last night's backup failed",
    body: detail,
    urgency: "interrupt",
    dedupeKey: `backup_failed:${await today(ctx)}`,
  });
}
