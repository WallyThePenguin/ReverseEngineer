// The worker: fires schedules (routines, reminders, checks), checks watched pages, syncs
// Google Calendar, mail, Slack and GitHub, and keeps an eye on Hearth's health.

import { githubAccount, googleAccount, slackWorkspace } from "@hearth/db";
import { integrationCaller, type Kernel, startScheduler } from "@hearth/kernel";
import { checkHealth, type HealthOptions, reportHealth } from "./health.ts";
import { jarvisWatchdog } from "./jarvis-watchdog.ts";
import { type MailRoundOptions, mailRound } from "./mail-loop.ts";
import { checkSchedules } from "./schedule-health.ts";
import { checkSyncs, ErrorClock } from "./sync-health.ts";
import { checkDueWatches } from "./watches.ts";

export interface WorkerOptions extends HealthOptions {
  kernel: Kernel;
  scheduleIntervalMs?: number;
  healthIntervalMs?: number;
  watchIntervalMs?: number;
  calendarIntervalMs?: number;
  mailIntervalMs?: number;
  mailRound?: Omit<MailRoundOptions, "log">;
  slackIntervalMs?: number;
  githubIntervalMs?: number;
  log?: (msg: string, err?: unknown) => void;
}

export function startWorker(opts: WorkerOptions) {
  const log = opts.log ?? ((m: string, e?: unknown) => console.error(`[worker] ${m}`, e ?? ""));
  const { kernel } = opts;
  const scheduler = startScheduler(kernel.db, kernel.clock, {
    intervalMs: opts.scheduleIntervalMs ?? 5000,
    log: (err) => log("running schedules failed", err),
  });
  const watchdog = jarvisWatchdog(kernel, { log });
  const syncErrors = new ErrorClock();
  const upSince = kernel.clock.now();
  let checking = false;
  const health = async () => {
    if (checking) return;
    checking = true;
    try {
      // A problem reading the syncs mustn't stop the worker's own check-in.
      const syncs = await checkSyncs(kernel, syncErrors).catch((err) => {
        log("checking the syncs failed", err);
        return [];
      });
      const schedules = await checkSchedules(kernel, upSince).then(
        (r) => [r],
        (err) => {
          log("checking the schedules failed", err);
          return [];
        },
      );
      await reportHealth(kernel, [...(await checkHealth(kernel, opts)), ...schedules, ...syncs]);
      await watchdog();
    } catch (err) {
      log("health check failed", err);
    } finally {
      checking = false;
    }
  };
  const timer = setInterval(health, opts.healthIntervalMs ?? 60_000);
  void health();

  let watching = false;
  const watches = async () => {
    if (watching) return 0;
    watching = true;
    try {
      return await checkDueWatches(kernel, 5, (m) => log(m));
    } catch (err) {
      log("checking page watches failed", err);
      return 0;
    } finally {
      watching = false;
    }
  };
  const watchTimer = setInterval(watches, opts.watchIntervalMs ?? 60_000);

  // Google Calendar, every five minutes once an account is connected.
  let syncing = false;
  const calendars = async () => {
    if (syncing) return;
    syncing = true;
    try {
      const [any] = await kernel.db
        .select({ email: googleAccount.email })
        .from(googleAccount)
        .limit(1);
      if (!any) return;
      const res = await kernel.execute("calendar.sync", {}, integrationCaller("google"));
      if (res.status !== "ok") log(`calendar sync: ${JSON.stringify(res)}`);
    } catch (err) {
      log("calendar sync failed", err);
    } finally {
      syncing = false;
    }
  };
  const calendarTimer = setInterval(calendars, opts.calendarIntervalMs ?? 5 * 60_000);
  void calendars();

  // Mail, every minute: each account in turn, paced, for under a minute a round (mail-loop.ts).
  let mailing = false;
  const mail = async () => {
    if (mailing) return;
    mailing = true;
    try {
      await mailRound(kernel, { ...opts.mailRound, log: (m) => log(m) });
    } catch (err) {
      log("mail sync failed", err);
    } finally {
      mailing = false;
    }
  };
  const mailTimer = setInterval(mail, opts.mailIntervalMs ?? 60_000);
  void mail();

  // Slack, every two minutes once a workspace is connected (a few channels per round).
  let slacking = false;
  const slack = async () => {
    if (slacking) return;
    slacking = true;
    try {
      const [any] = await kernel.db
        .select({ team: slackWorkspace.teamId })
        .from(slackWorkspace)
        .limit(1);
      if (!any) return;
      const res = await kernel.execute("slack.sync", {}, integrationCaller("slack"));
      if (res.status !== "ok") log(`slack sync: ${JSON.stringify(res)}`);
    } catch (err) {
      log("slack sync failed", err);
    } finally {
      slacking = false;
    }
  };
  const slackTimer = setInterval(slack, opts.slackIntervalMs ?? 2 * 60_000);
  void slack();

  // GitHub pull requests, every two minutes once a token is connected.
  let pulling = false;
  const github = async () => {
    if (pulling) return;
    pulling = true;
    try {
      const [any] = await kernel.db
        .select({ login: githubAccount.login })
        .from(githubAccount)
        .limit(1);
      if (!any) return;
      const res = await kernel.execute("github.sync", {}, integrationCaller("github"));
      if (res.status !== "ok") log(`github sync: ${JSON.stringify(res)}`);
    } catch (err) {
      log("github sync failed", err);
    } finally {
      pulling = false;
    }
  };
  const githubTimer = setInterval(github, opts.githubIntervalMs ?? 2 * 60_000);
  void github();

  return {
    health,
    slack,
    github,
    watches,
    calendars,
    mail,
    tick: scheduler.tick,
    stop() {
      clearInterval(timer);
      clearInterval(watchTimer);
      clearInterval(calendarTimer);
      clearInterval(mailTimer);
      clearInterval(slackTimer);
      clearInterval(githubTimer);
      scheduler.stop();
    },
  };
}
