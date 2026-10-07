// Hearth itself: component health, backups, and the switch that pauses Jarvis's initiative.
import {
  type DbOrTx,
  googleAccount,
  pushSubscription,
  schedule,
  session,
  setting,
} from "@hearth/db";
import {
  type DigestItem,
  defineAction,
  defineModule,
  getSetting,
  setSetting,
} from "@hearth/kernel";
import { and, asc, count, eq, isNotNull, isNull, like, ne } from "drizzle-orm";
import { z } from "zod";
import { alertBackupFailed, alertFailing, closeFailing } from "./alerts.ts";
import { judgeHealth } from "./staleness.ts";

export {
  EXTERNAL_COMPONENTS,
  type JudgedHealth,
  judgeHealth,
  REPORT_EVERY_MS,
  roughly,
} from "./staleness.ts";

const STATUS = z.enum(["ok", "degraded", "failing"]);
export type HealthStatus = z.infer<typeof STATUS>;

export interface HealthRecord {
  status: HealthStatus;
  detail: string;
  at: string;
}

/** What's connected so far, for the "Set up Hearth" checklist. Counts only, nothing secret. */
async function setupState(tx: DbOrTx) {
  const [google] = await tx
    .select({ n: count() })
    .from(googleAccount)
    .where(ne(googleAccount.status, "revoked"));
  const [phone] = await tx.select({ n: count() }).from(pushSubscription);
  const [desktop] = await tx
    .select({ n: count() })
    .from(session)
    .where(and(like(session.label, "device:%"), isNull(session.revokedAt)));
  return {
    google: (google?.n ?? 0) > 0,
    chrome: (await getSetting(tx, "browser.pairing")) !== null,
    phone: (phone?.n ?? 0) > 0,
    desktop: (desktop?.n ?? 0) > 0,
  };
}

export const systemModule = defineModule({
  name: "system",
  description: "Hearth's own health: services, syncs and backups, and pausing Jarvis.",
  entityTypes: [],
  events: [
    {
      kind: "system.health_changed",
      description: "A component's status changed. Payload: component, status, previous, detail.",
    },
    {
      kind: "system.backup_finished",
      description: "A backup ran. Payload: ok, detail, snapshot, restoreTested.",
    },
    {
      kind: "jarvis.paused_changed",
      description: "You paused or resumed Jarvis's proactive work. Payload: paused.",
    },
  ],
  knowledge: {},
  actions: [
    defineAction({
      name: "system.status",
      description:
        "Report Hearth's health: each component, the next scheduled routines, and whether Jarvis is paused.",
      input: z.object({}),
      risk: "read",
      async handler(_i, ctx) {
        const health = await ctx.tx.select().from(setting).where(like(setting.key, "health.%"));
        const schedules = await ctx.tx
          .select({
            id: schedule.id,
            nextRunAt: schedule.nextRunAt,
            lastRunAt: schedule.lastRunAt,
            lastOutcome: schedule.lastOutcome,
          })
          .from(schedule)
          .where(isNotNull(schedule.nextRunAt))
          .orderBy(asc(schedule.nextRunAt))
          .limit(20);
        return {
          setup: await setupState(ctx.tx),
          jarvisPaused: await getSetting(ctx.tx, "jarvis.paused"),
          /** When the Jarvis process last checked in (every 30 s) and since when it's up (D54). */
          jarvisAlive: await getSetting(ctx.tx, "jarvis.alive"),
          // A component that stopped reporting shows as failing, not as its last word.
          components: Object.fromEntries(
            health.map((h) => {
              const name = h.key.slice("health.".length);
              return [name, judgeHealth(name, h.value as HealthRecord, ctx.now)];
            }),
          ),
          schedules,
        };
      },
    }),
    defineAction({
      name: "system.report",
      description: "Record a component's health (used by Hearth's services).",
      input: z.object({
        component: z.string().regex(/^[a-z0-9_.-]+$/),
        status: STATUS,
        detail: z.string().max(2000).default(""),
      }),
      risk: "internal",
      callers: ["system", "owner"],
      // Every component reports every minute; only a change of status is worth an audit row.
      auditWhen: (r: { changed: boolean }) => r.changed,
      async handler(i, ctx) {
        const key = `health.${i.component}`;
        const [prev] = await ctx.tx.select().from(setting).where(eq(setting.key, key));
        const previous = (prev?.value as HealthRecord | undefined)?.status ?? null;
        const value: HealthRecord = {
          status: i.status,
          detail: i.detail,
          at: ctx.now.toISOString(),
        };
        await ctx.tx
          .insert(setting)
          .values({ key, value, updatedAt: ctx.now })
          .onConflictDoUpdate({ target: setting.key, set: { value, updatedAt: ctx.now } });
        if (previous !== i.status) {
          ctx.emit({
            kind: "system.health_changed",
            payload: { component: i.component, status: i.status, previous, detail: i.detail },
          });
          if (i.status === "failing") await alertFailing(ctx, i.component, i.detail);
          else if (previous === "failing") await closeFailing(ctx, i.component);
        }
        return { changed: previous !== i.status };
      },
    }),
    defineAction({
      name: "system.backup_finished",
      description: "Record the result of a backup run (used by the backup script).",
      input: z.object({
        ok: z.boolean(),
        detail: z.string().max(4000).default(""),
        snapshot: z.string().max(200).optional(),
        restoreTested: z.boolean().default(false),
      }),
      risk: "internal",
      callers: ["system", "owner"],
      async handler(i, ctx) {
        const value: HealthRecord = {
          status: i.ok ? "ok" : "failing",
          detail: i.detail,
          at: ctx.now.toISOString(),
        };
        await ctx.tx
          .insert(setting)
          .values({ key: "health.backup", value, updatedAt: ctx.now })
          .onConflictDoUpdate({ target: setting.key, set: { value, updatedAt: ctx.now } });
        ctx.emit({
          kind: "system.backup_finished",
          payload: {
            ok: i.ok,
            detail: i.detail,
            snapshot: i.snapshot ?? null,
            restoreTested: i.restoreTested,
          },
        });
        if (!i.ok) await alertBackupFailed(ctx, i.detail);
        // Written here, not through system.report: a backup that ran closes "The nightly backup is
        // failing", which the worker raises when none has run for a day and a half.
        else await closeFailing(ctx, "backup");
        return { recorded: true };
      },
    }),
    defineAction({
      name: "jarvis.pause",
      description: "Pause Jarvis's proactive work. It still answers when you talk to it.",
      input: z.object({}),
      risk: "internal",
      callers: ["owner"],
      async handler(_i, ctx) {
        await setSetting(ctx.tx, "jarvis.paused", true);
        ctx.emit({ kind: "jarvis.paused_changed", payload: { paused: true } });
        return { paused: true };
      },
    }),
    defineAction({
      name: "jarvis.resume",
      description: "Resume Jarvis's proactive work.",
      input: z.object({}),
      risk: "internal",
      callers: ["owner"],
      async handler(_i, ctx) {
        await setSetting(ctx.tx, "jarvis.paused", false);
        ctx.emit({ kind: "jarvis.paused_changed", payload: { paused: false } });
        return { paused: false };
      },
    }),
  ],
  reflexes: [],
  noReflexesBecause:
    "A failing component or backup is told by system.report and system.backup_finished themselves (alerts.ts): reflexes run only in the Jarvis process, and these alerts must reach you while it's down.",
  async digest(ctx): Promise<DigestItem[]> {
    const rows = await ctx.db.select().from(setting).where(like(setting.key, "health.%"));
    const items: DigestItem[] = [];
    for (const r of rows) {
      const h = r.value as HealthRecord;
      const name = r.key.slice("health.".length);
      if (h.status !== "ok")
        items.push({ bucket: "fyi", text: `${name} is ${h.status}: ${h.detail}` });
      else if (name === "backup" && new Date(h.at) >= ctx.since)
        items.push({ bucket: "handled", text: "Backup ran and finished cleanly" });
    }
    if (await getSetting(ctx.db, "jarvis.paused"))
      items.push({
        bucket: "fyi",
        text: "Jarvis is paused: no proactive work until you resume it",
      });
    return items;
  },
});
