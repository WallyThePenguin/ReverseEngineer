// Hearth itself: component health, backups, and the switch that pauses Jarvis's initiative.
import { schedule, setting } from "@hearth/db";
import {
  type DigestItem,
  defineAction,
  defineModule,
  getSetting,
  setSetting,
} from "@hearth/kernel";
import { asc, eq, isNotNull, like } from "drizzle-orm";
import { z } from "zod";

const STATUS = z.enum(["ok", "degraded", "failing"]);
export type HealthStatus = z.infer<typeof STATUS>;

export interface HealthRecord {
  status: HealthStatus;
  detail: string;
  at: string;
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
          jarvisPaused: await getSetting(ctx.tx, "jarvis.paused"),
          components: Object.fromEntries(
            health.map((h) => [h.key.slice("health.".length), h.value as HealthRecord]),
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
  reflexes: [
    {
      name: "system.alert_on_failure",
      description:
        "Tells you when a sync, service or backup starts failing, even when Jarvis is paused.",
      mode: "always",
      on: ["system.health_changed", "system.backup_finished"],
      includeJarvisEvents: true,
      run(event, ctx) {
        const day = ctx.now.toISOString().slice(0, 10);
        if (event.kind === "system.backup_finished") {
          if (event.payload.ok) return [];
          return [
            {
              kind: "tell",
              notification: {
                kind: "system.alert",
                title: "Last night's backup failed",
                body: String(event.payload.detail ?? ""),
                urgency: "normal",
                dedupeKey: `backup_failed:${day}`,
              },
            },
          ];
        }
        const { component, status, detail } = event.payload as {
          component: string;
          status: string;
          detail: string;
        };
        if (status !== "failing") return [];
        return [
          {
            kind: "tell",
            notification: {
              kind: "system.alert",
              title: `${component} is failing`,
              body: detail,
              urgency: "normal",
              dedupeKey: `failing:${component}:${day}`,
            },
          },
        ];
      },
    },
  ],
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
