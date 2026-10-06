// The Notion loop (D68). Each round reads every ticket assigned to you on your task board (a few
// requests: the board's columns, then its pages a hundred at a time) and compares them with what
// it read before. What changed becomes an event for Jarvis, which makes and closes your Hearth
// tasks: a ticket newly yours, one that's done, one whose title or due date moved, an open one
// that isn't yours any more. The first
// round brings in your open tickets quietly (backfill: true). Tickets are other people's words.
import { entity, notionAccount, notionTask } from "@hearth/db";
import { type ActionContext, createEntity, savepoint, updateEntity } from "@hearth/kernel";
import { and, eq, inArray, ne } from "drizzle-orm";
import { VAULT_SERVICE, type Vault } from "../browser/vault.ts";
import { closeAlerts, nextHealth, type Trouble } from "../connector-health.ts";
import { NOTION_SERVICE, type NotionApi, NotionError, type NotionPage } from "./api.ts";
import { type Columns, pickColumns, type Ticket, ticketOf } from "./columns.ts";

export type AccountRow = typeof notionAccount.$inferSelect;
/** A ticket as last read, with its record's title. */
type Known = typeof notionTask.$inferSelect & { title: string; deletedAt: Date | null };

/** Pages of a hundred tickets one round may read. */
export const MAX_PAGES = 20;

export const notionApi = (ctx: Pick<ActionContext, "service">) =>
  ctx.service<NotionApi>(NOTION_SERVICE);
export const sealToken = (ctx: Pick<ActionContext, "service">, botId: string, token: string) =>
  ctx.service<Vault>(VAULT_SERVICE).seal("notion.so", botId, token);
export const openToken = (ctx: Pick<ActionContext, "service">, a: AccountRow) =>
  ctx.service<Vault>(VAULT_SERVICE).open("notion.so", a.botId, a.token);

// Hearth's own link tags can't be forged from a ticket's title (they'd link records it names).
const defuse = (s: string) => s.replace(/<(\/?m-ref)/gi, "‹$1");

type Change = "notion.task_assigned" | "notion.task_done" | "notion.task_changed";

/** What every notion.task_* event says about its ticket (the module's TASK_PAYLOAD). */
const payloadOf = (
  t: { title: string; status: string | null; dueAt: string | null; dueIsDate: boolean },
  url: string,
  board: { title: string },
  first: boolean,
) => ({
  title: t.title,
  status: t.status,
  dueAt: t.dueAt,
  dueIsDate: t.dueIsDate,
  url,
  database: board.title,
  backfill: first,
});

/** The event a ticket's new reading makes, compared with the last one (none on a quiet round). */
export function changeOf(
  before: Known | undefined,
  t: Ticket,
  first: boolean,
): { kind: Change; changed?: ("title" | "due")[] } | null {
  const open = !t.done;
  // Newly yours: a new ticket, one assigned to you again, or one reopened.
  if (!before?.assigned || (before.done && open))
    return open ? { kind: "notion.task_assigned" } : null;
  if (first) return null;
  if (!before.done && t.done) return { kind: "notion.task_done" };
  if (t.done) return null;
  const changed: ("title" | "due")[] = [];
  if (before.title !== t.title) changed.push("title");
  if (before.dueAt !== t.dueAt || before.dueIsDate !== t.dueIsDate) changed.push("due");
  return changed.length ? { kind: "notion.task_changed", changed } : null;
}

async function follow(
  ctx: ActionContext,
  board: { id: string; title: string },
  p: NotionPage,
  t: Ticket,
  before: Known | undefined,
  first: boolean,
) {
  const title = defuse(t.title || "Untitled").slice(0, 500);
  const values = {
    url: p.url,
    status: t.status,
    done: t.done,
    dueAt: t.dueAt,
    dueIsDate: t.dueIsDate,
    assigned: true,
    editedAt: p.editedAt,
  };
  let id: string;
  if (before) {
    id = before.entityId;
    await updateEntity(ctx, id, { title });
    await ctx.tx.update(notionTask).set(values).where(eq(notionTask.entityId, id));
  } else {
    id = (await createEntity(ctx, { type: "notion_task", title })).id;
    await ctx.tx
      .insert(notionTask)
      .values({ entityId: id, pageId: p.id, sourceId: board.id, backfill: first, ...values });
  }
  const change = changeOf(before, { ...t, title }, first);
  if (!change) return null;
  ctx.emit({
    kind: change.kind,
    entityId: id,
    payload: {
      ...payloadOf({ ...t, title }, p.url, board, first),
      ...(change.changed ? { changed: change.changed } : {}),
    },
  });
  return change.kind;
}

export interface NotionSyncResult {
  tickets: number;
  assigned: number;
  done: number;
  changed: number;
  unassigned: number;
  failed: string[];
}

async function readBoard(ctx: ActionContext, account: AccountRow, token: string, sourceId: string) {
  const api = notionApi(ctx);
  const schema = await api.schema(token, sourceId);
  // Who a ticket is for comes from the column you picked the board with, never a fresh guess: a
  // renamed column must not let the whole board in as yours. Gone, it's for you to pick again.
  const assignee = account.columns ? account.columns.assignee : pickColumns(schema).assignee;
  if (assignee && !schema.columns.some((c) => c.name === assignee && c.type === "people"))
    throw new NotionError(
      400,
      `${schema.title} has no "${assignee}" column any more, which said who a ticket is for. Pick the board again in Settings > Notion.`,
    );
  if (assignee && !account.ownerUserId)
    throw new NotionError(400, "Pick who you are on the board in Settings > Notion.");
  const cols: Columns = { ...pickColumns(schema), assignee };
  const person =
    assignee && account.ownerUserId ? { column: assignee, userId: account.ownerUserId } : undefined;
  // Notion was asked for yours only; one that isn't is left out all the same.
  const mine = (p: NotionPage) => !person || ticketOf(p, cols).assignees.includes(person.userId);
  const pages = new Map<string, NotionPage>();
  let cursor: string | null = null;
  let whole = false;
  for (let n = 0; n < MAX_PAGES; n++) {
    const r = await api.pages(token, sourceId, { person, cursor });
    // One made while Hearth read pushes the rest down a place, so one can show up twice.
    for (const p of r.pages) if (!pages.has(p.id) && mine(p)) pages.set(p.id, p);
    cursor = r.next;
    if (!cursor) {
      whole = true;
      break;
    }
  }
  const rows = await ctx.tx
    .select({ row: notionTask, title: entity.title, deletedAt: entity.deletedAt })
    .from(notionTask)
    .innerJoin(entity, eq(entity.id, notionTask.entityId))
    .where(eq(notionTask.sourceId, sourceId));
  const known = new Map(
    rows.map((r) => [r.row.pageId, { ...r.row, title: r.title, deletedAt: r.deletedAt }]),
  );
  const first = account.syncedAt === null;
  const board = { id: sourceId, title: schema.title };
  const out = { tickets: pages.size, assigned: 0, done: 0, changed: 0, unassigned: 0 };
  for (const p of pages.values()) {
    const before = known.get(p.id);
    // One you deleted in Hearth stays out of it, rather than fail every round.
    if (before?.deletedAt) continue;
    const kind = await follow(ctx, board, p, ticketOf(p, cols), before, first);
    if (kind === "notion.task_assigned") out.assigned++;
    else if (kind === "notion.task_done") out.done++;
    else if (kind === "notion.task_changed") out.changed++;
  }
  // Only a whole read can tell a ticket is no longer yours (reassigned, or deleted in Notion).
  const gone = [...known.values()].filter((k) => k.assigned && !pages.has(k.pageId));
  if (whole && gone.length) {
    await ctx.tx
      .update(notionTask)
      .set({ assigned: false })
      .where(
        inArray(
          notionTask.entityId,
          gone.map((g) => g.entityId),
        ),
      );
    // An open one leaving you is news (its task can go); a done one's task is closed already.
    for (const g of gone.filter((k) => !k.done && !k.deletedAt)) {
      ctx.emit({
        kind: "notion.task_unassigned",
        entityId: g.entityId,
        payload: payloadOf(g, g.url, board, first),
      });
      out.unassigned++;
    }
  }
  await ctx.tx
    .update(notionAccount)
    .set({ columns: cols, sourceTitle: schema.title })
    .where(eq(notionAccount.botId, account.botId));
  return out;
}

export async function syncNotion(ctx: ActionContext): Promise<NotionSyncResult> {
  const result: NotionSyncResult = {
    tickets: 0,
    assigned: 0,
    done: 0,
    changed: 0,
    unassigned: 0,
    failed: [],
  };
  const [account] = await ctx.tx.select().from(notionAccount).limit(1);
  // Nothing to read until you've picked the board (and who you are on it) in Settings.
  if (!account?.sourceId || (account.columns?.assignee && !account.ownerUserId)) return result;
  // A token that stopped working isn't tried again until you paste a new one.
  if (account.syncState === "revoked")
    return { ...result, failed: account.lastError ? [account.lastError] : [] };
  const token = openToken(ctx, account);
  let trouble: Trouble | null = null;
  let progressed = false;
  try {
    const sourceId = account.sourceId;
    Object.assign(result, await savepoint(ctx, (sp) => readBoard(sp, account, token, sourceId)));
    progressed = true;
  } catch (err) {
    const kind = err instanceof NotionError ? err.kind : "transient";
    // Slowing down when asked is normal; the next round tries again.
    if (kind === "slow") return result;
    const message = err instanceof Error ? err.message : String(err);
    trouble = { kind, message };
    result.failed.push(message);
  }
  const next = nextHealth(account, ctx.now, trouble, progressed);
  await ctx.tx.update(notionAccount).set(next.values).where(eq(notionAccount.botId, account.botId));
  if (next.recovered) await closeAlerts(ctx, "notion");
  if (next.alert)
    ctx.emit({
      kind: "notion.sync_failed",
      payload: {
        errors: result.failed,
        since: next.alert.since.toISOString(),
        reconnect: next.alert.reconnect,
      },
    });
  return result;
}

/** Forgets the tickets of any board but this one (you picked another), or all of them. */
export async function forgetTickets(ctx: ActionContext, keep: string | null) {
  const ids = ctx.tx
    .select({ id: notionTask.entityId })
    .from(notionTask)
    .where(keep ? ne(notionTask.sourceId, keep) : undefined);
  await ctx.tx.delete(entity).where(and(inArray(entity.id, ids), eq(entity.type, "notion_task")));
}
