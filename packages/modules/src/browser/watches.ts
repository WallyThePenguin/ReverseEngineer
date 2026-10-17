// Page watches (B1): Hearth checks a page on a schedule and tells you when it changes. Checks
// run in the worker as the system, with no model involved; Jarvis gets a turn only when the
// watch says what to do on a change. The page's text is outside content (D25): it stays on the
// watch, never goes into notices or events, and reading the watch makes Jarvis's turn untrusted.
import { formatDateTime, PRINCIPAL } from "@hearth/core";
import { type DbOrTx, entity, type PageWatchStatus, pageWatch } from "@hearth/db";
import {
  type ActionContext,
  ActionError,
  createEntity,
  createNotification,
  type Describe,
  defineAction,
  type ReflexDef,
  updateEntity,
} from "@hearth/kernel";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { id } from "../shared.ts";
import { assertAllowed, browser, CALLERS } from "./access.ts";
import type { TabInfo } from "./client.ts";
import { fetchPageText, isPrivateHost } from "./fetch-page.ts";
import { forgetLinks, readPage, waitForLoad } from "./page.ts";

const MAX_TEXT = 20_000;
/** After this many failed checks in a row, you're told once. */
const FAILURES_TO_TELL = 3;

const minutes = z
  .number()
  .int()
  .min(15)
  .max(7 * 24 * 60);
const onChange = z
  .string()
  .trim()
  .max(1000)
  .describe(
    "What Pip should do when the page changes, e.g. 'tell me if the price drops under $30'. Without it, the owner just gets a notice.",
  );
const selector = z
  .string()
  .trim()
  .max(300)
  .describe("A CSS selector to watch part of the page, like a price (browser mode only).");

type WatchRow = typeof pageWatch.$inferSelect & { title: string; createdBy: string };

async function loadWatch(db: DbOrTx, watchId: string): Promise<WatchRow | null> {
  const [row] = await db
    .select({ w: pageWatch, title: entity.title, createdBy: entity.createdBy })
    .from(pageWatch)
    .innerJoin(entity, eq(entity.id, pageWatch.entityId))
    .where(and(eq(pageWatch.entityId, watchId), isNull(entity.deletedAt)));
  return row ? { ...row.w, title: row.title, createdBy: row.createdBy } : null;
}

/** A follow-up is your instruction, so it can't come from a turn that read outside content. */
function assertFollowUpAllowed(ctx: ActionContext, value: string | null | undefined): void {
  if (value && ctx.caller.origin === "untrusted")
    throw new ActionError(
      "forbidden",
      "A watch's follow-up can't come from outside content. Ask the owner to add it.",
    );
}

/** Reads the watched page now: in Chrome, signed in as you, or with a plain fetch. */
async function readNow(ctx: ActionContext, w: WatchRow): Promise<string> {
  if (w.mode === "fetch") {
    // Your own network only for watches you set up yourself.
    const page = await fetchPageText(w.url, { allowPrivate: w.createdBy === PRINCIPAL.owner });
    await assertAllowed(ctx, page.url, true);
    return page.text;
  }
  const client = browser(ctx);
  // In Jarvis's window, behind its current tab, and closed again after.
  const tab = await client.call<TabInfo>("tabs.open", { url: w.url, show: false });
  try {
    await waitForLoad(client, tab.tabId);
    const page = await readPage(client, tab.tabId, MAX_TEXT, w.selector ?? undefined);
    await assertAllowed(ctx, page.url, true);
    return page.missing ? `(Nothing on the page matches ${w.selector}.)` : page.text;
  } finally {
    forgetLinks(tab.tabId);
    await client.call("tabs.close", { tabId: tab.tabId }).catch(() => {});
  }
}

export const describeWatch: Describe = async (entityId, ctx) => {
  const w = await loadWatch(ctx.db, entityId);
  if (!w) return null;
  const how = w.mode === "fetch" ? "fetched without signing in" : "in the owner's Chrome";
  const lines = [
    `# ${w.title}`,
    `id: ${entityId} · page watch · ${w.active ? "on" : "paused"} · ${w.status}`,
    `Watching ${w.url}${w.selector ? ` (just ${w.selector})` : ""}, every ${w.everyMinutes} minutes, ${how}.`,
  ];
  if (w.lastCheckedAt) lines.push(`Last checked: ${formatDateTime(w.lastCheckedAt)}`);
  if (w.lastChangedAt) lines.push(`Last changed: ${formatDateTime(w.lastChangedAt)}`);
  if (w.lastError) lines.push(`Last problem: ${w.lastError}`);
  if (w.thenAsk) lines.push(`When it changes: ${w.thenAsk}`);
  if (w.lastText !== null) lines.push("", "## Now", w.lastText.slice(0, 6000));
  if (w.previousText !== null) lines.push("", "## Before", w.previousText.slice(0, 6000));
  return lines.join("\n");
};

export const watchActions = [
  defineAction({
    name: "page_watch.create",
    description:
      "Watch a web page and get told when it changes: a price, an order's status, a new listing. Checks run on a schedule, in the owner's Chrome (signed in as them) or with a plain fetch for public pages.",
    input: z.object({
      url: z.string().max(4000),
      title: z.string().trim().max(200).optional().describe("A short name, e.g. 'Kettle price'."),
      mode: z.enum(["browser", "fetch"]).default("browser"),
      selector: selector.optional(),
      everyMinutes: minutes.default(60),
      onChange: onChange.optional(),
    }),
    risk: "internal",
    callers: CALLERS,
    // The page gets opened again and again later, so an untrusted turn is held to D25 here too.
    opensUrl: (i) => i.url,
    summarize: (i) => `Watch ${i.url} every ${i.everyMinutes} minutes`,
    async handler(i, ctx) {
      if (i.selector && i.mode === "fetch")
        throw new ActionError("invalid_input", "Watching part of a page needs browser mode.");
      assertFollowUpAllowed(ctx, i.onChange);
      // Watches run later without you, so even you can't point one at a blocked site.
      const url = await assertAllowed(ctx, i.url, true);
      const host = new URL(url).hostname;
      if (i.mode === "fetch" && ctx.caller.kind !== "owner" && isPrivateHost(host))
        throw new ActionError(
          "forbidden",
          `${host} is on your own network; only you can watch it.`,
        );
      const row = await createEntity(ctx, {
        type: "page_watch",
        title: i.title || `Watch ${host}`,
      });
      await ctx.tx.insert(pageWatch).values({
        entityId: row.id,
        url,
        mode: i.mode,
        selector: i.selector || null,
        everyMinutes: i.everyMinutes,
        thenAsk: i.onChange || null,
        nextCheckAt: ctx.now,
      });
      return { id: row.id, title: row.title, url, firstCheck: "within a minute" };
    },
  }),
  defineAction({
    name: "page_watch.update",
    description: "Change a page watch: its name, how often it checks, the follow-up, or pause it.",
    input: z.object({
      id,
      title: z.string().trim().min(1).max(200).optional(),
      everyMinutes: minutes.optional(),
      onChange: onChange.nullable().optional(),
      active: z.boolean().optional(),
    }),
    risk: "internal",
    callers: CALLERS,
    async handler(i, ctx) {
      assertFollowUpAllowed(ctx, i.onChange);
      const w = await loadWatch(ctx.tx, i.id);
      if (!w) throw new ActionError("not_found", "No page watch with that id.");
      if (i.title) await updateEntity(ctx, i.id, { title: i.title }, { type: "page_watch" });
      await ctx.tx
        .update(pageWatch)
        .set({
          ...(i.everyMinutes ? { everyMinutes: i.everyMinutes } : {}),
          ...(i.onChange !== undefined ? { thenAsk: i.onChange || null } : {}),
          ...(i.active !== undefined ? { active: i.active } : {}),
          ...(i.active ? { nextCheckAt: ctx.now } : {}),
        })
        .where(eq(pageWatch.entityId, i.id));
      return { ok: true };
    },
  }),
  defineAction({
    name: "page_watch.list",
    description:
      "List page watches: what each watches, how often, its status, and when it last changed. Read one with record_read to see the page's text.",
    input: z.object({}),
    risk: "read",
    callers: CALLERS,
    async handler(_i, ctx) {
      const rows = await ctx.tx
        .select({ w: pageWatch, title: entity.title })
        .from(pageWatch)
        .innerJoin(entity, eq(entity.id, pageWatch.entityId))
        .where(isNull(entity.deletedAt))
        .orderBy(asc(entity.title));
      return rows.map(({ w, title }) => ({
        id: w.entityId,
        title,
        url: w.url,
        mode: w.mode,
        selector: w.selector,
        everyMinutes: w.everyMinutes,
        onChange: w.thenAsk,
        active: w.active,
        status: w.status,
        lastCheckedAt: w.lastCheckedAt,
        lastChangedAt: w.lastChangedAt,
        lastError: w.lastError,
      }));
    },
  }),
  defineAction({
    name: "page_watch.get",
    description: "One page watch with the page's text now and before its last change.",
    input: z.object({ id }),
    risk: "read",
    callers: CALLERS,
    // The page's text came from the web.
    external: true,
    async handler(i, ctx) {
      const w = await loadWatch(ctx.tx, i.id);
      if (!w) throw new ActionError("not_found", "No page watch with that id.");
      const { entityId, thenAsk, failures: _f, ...rest } = w;
      return { id: entityId, onChange: thenAsk, ...rest };
    },
  }),
  defineAction({
    name: "page_watch.check",
    description: "Check a watched page now. Says whether it changed; the text stays on the watch.",
    input: z.object({ id }),
    risk: "internal",
    callers: CALLERS,
    async handler(i, ctx) {
      const w = await loadWatch(ctx.tx, i.id);
      if (!w) throw new ActionError("not_found", "No page watch with that id.");
      let text: string | null = null;
      let problem: { message: string; offline: boolean } | null = null;
      try {
        text = (await readNow(ctx, w)).slice(0, MAX_TEXT);
      } catch (err) {
        const offline = err instanceof ActionError && err.code === "unavailable";
        problem = { message: err instanceof Error ? err.message : String(err), offline };
      }
      const every = problem?.offline ? Math.min(w.everyMinutes, 15) : w.everyMinutes;
      const next = new Date(ctx.now.getTime() + every * 60_000);
      if (problem) {
        const failures = problem.offline ? w.failures : w.failures + 1;
        const status: PageWatchStatus = problem.offline
          ? "waiting"
          : failures >= FAILURES_TO_TELL
            ? "failing"
            : w.status;
        await ctx.tx
          .update(pageWatch)
          .set({
            lastCheckedAt: ctx.now,
            nextCheckAt: next,
            status,
            failures,
            lastError: problem.message,
          })
          .where(eq(pageWatch.entityId, w.entityId));
        if (failures === FAILURES_TO_TELL && w.failures < FAILURES_TO_TELL) {
          ctx.emit({ kind: "page_watch.failing", entityId: w.entityId, payload: { url: w.url } });
          await createNotification(ctx, {
            kind: "page_watch.failing",
            title: `Can't check: ${w.title}`,
            body: problem.message,
            entityId: w.entityId,
          });
        }
        return { changed: false, status, error: problem.message };
      }
      const changed = w.lastText !== null && text !== w.lastText;
      await ctx.tx
        .update(pageWatch)
        .set({
          lastCheckedAt: ctx.now,
          nextCheckAt: next,
          status: "ok",
          failures: 0,
          lastError: null,
          lastText: text,
          ...(changed ? { previousText: w.lastText, lastChangedAt: ctx.now } : {}),
        })
        .where(eq(pageWatch.entityId, w.entityId));
      if (changed) {
        ctx.emit({
          kind: "page_watch.changed",
          entityId: w.entityId,
          payload: { url: w.url, title: w.title, followUp: w.thenAsk !== null },
        });
        await createNotification(ctx, {
          kind: "page_watch.changed",
          title: `Changed: ${w.title}`,
          body: `Checked ${formatDateTime(ctx.now)}. Open the watch to see what's different.`,
          entityId: w.entityId,
        });
      }
      return { changed, status: "ok" as const };
    },
  }),
];

/** When a watched page changes and you said what to do about it, Jarvis does it. */
export const watchFollowUp: ReflexDef = {
  name: "page_watch.follow_up",
  description: "When a watched page changes and the watch says what to do, Pip does it.",
  mode: "reactive",
  on: ["page_watch.changed"],
  async run(event, ctx) {
    if (!event.entityId || !event.payload.followUp) return [];
    const w = await loadWatch(ctx.db, event.entityId);
    if (!w?.thenAsk) return [];
    return [
      {
        kind: "turn",
        trigger: "watch",
        lane: "fast",
        subjectId: w.entityId,
        dedupeKey: `page_watch:${w.entityId}:${event.id}`,
        prompt: [
          `A page the owner watches changed: "${w.title}" (${w.url}).`,
          `They asked: ${w.thenAsk}`,
          "Compare the watch's Now and Before text, and do what they asked. If it doesn't apply to this change, do nothing.",
        ].join("\n"),
      },
    ];
  },
};
