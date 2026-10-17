// Connecting Notion for tasks (D68), from Settings: paste an internal integration's token, pick
// the task board and who you are on it. The token is only ever yours to give, and stays sealed.
import { entity, googleAccount, notionAccount, notionTask } from "@hearth/db";
import { type ActionContext, ActionError, defineAction } from "@hearth/kernel";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { closeAlerts } from "../connector-health.ts";
import { NotionError } from "./api.ts";
import { pickColumns } from "./columns.ts";
import { forgetTickets, notionApi, openToken, sealToken, syncNotion } from "./sync.ts";

// Internal integration secrets: "ntn_…" now, "secret_…" before September 2024.
const token = z
  .string()
  .trim()
  .regex(/^(ntn_|secret_)[A-Za-z0-9]{20,200}$/, "a Notion integration secret (ntn_…)");

/** What Notion said, as an error you can act on. */
async function ask<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (err) {
    throw new ActionError(
      "invalid_input",
      err instanceof NotionError ? err.message : "Notion couldn't be reached.",
    );
  }
}

async function account(ctx: ActionContext) {
  const [a] = await ctx.tx.select().from(notionAccount).limit(1);
  if (!a) throw new ActionError("not_found", "Notion isn't connected.");
  return a;
}

const healthy = { syncState: "ok", failures: 0, failingSince: null, lastError: null } as const;

/**
 * Still yours and not done, as of the last reading. A ticket you moved to the trash in Hearth
 * isn't read again (sync.ts), so it would stay open for good: it's left out instead.
 */
const openTicket = and(
  eq(notionTask.assigned, true),
  eq(notionTask.done, false),
  isNull(entity.deletedAt),
);

export const connectActions = [
  defineAction({
    name: "notion.connect",
    description: "Connect Notion for tasks with an internal integration's secret.",
    input: z.object({ token }),
    // Only you, from Settings; the audit log keeps none of it.
    risk: "secret",
    callers: ["owner"],
    async handler(i, ctx) {
      const me = await ask(() => notionApi(ctx).whoami(i.token));
      const [had] = await ctx.tx.select().from(notionAccount);
      if (had && had.botId !== me.botId)
        throw new ActionError(
          "conflict",
          "Notion is connected with another integration. Disconnect it first to switch.",
        );
      await ctx.tx.delete(notionAccount);
      await ctx.tx.insert(notionAccount).values({
        botId: me.botId,
        workspace: me.workspace,
        token: sealToken(ctx, me.botId, i.token),
      });
      await closeAlerts(ctx, "notion");
      return { workspace: me.workspace };
    },
  }),
  defineAction({
    name: "notion.replace_token",
    description:
      "Give Nook a new secret for the connected Notion integration (the old one was refreshed or revoked), keeping the board and tickets read in.",
    input: z.object({ token }),
    risk: "secret",
    callers: ["owner"],
    async handler(i, ctx) {
      const a = await account(ctx);
      const me = await ask(() => notionApi(ctx).whoami(i.token));
      if (me.botId !== a.botId)
        throw new ActionError(
          "invalid_input",
          "That secret is for another Notion integration. Disconnect first to switch.",
        );
      await ctx.tx
        .update(notionAccount)
        .set({ token: sealToken(ctx, a.botId, i.token), workspace: me.workspace, ...healthy })
        .where(eq(notionAccount.botId, a.botId));
      await closeAlerts(ctx, "notion");
      return { workspace: me.workspace };
    },
  }),
  defineAction({
    name: "notion.choices",
    description:
      "The Notion databases the integration can see, and the people in the workspace, with the one Nook thinks is you.",
    input: z.object({}),
    risk: "read",
    callers: ["owner"],
    async handler(_i, ctx) {
      const a = await account(ctx);
      const t = openToken(ctx, a);
      const boards = await ask(() => notionApi(ctx).sources(t));
      const people = await ask(() => notionApi(ctx).people(t));
      // You: the person whose email is one of your Google accounts', if Notion shares emails.
      const mine = new Set(
        (await ctx.tx.select({ email: googleAccount.email }).from(googleAccount)).map((g) =>
          g.email.toLowerCase(),
        ),
      );
      const guess = people.find((p) => p.email && mine.has(p.email.toLowerCase()));
      return {
        boards,
        people: people.map((p) => ({ id: p.id, name: p.name })),
        you: a.ownerUserId ?? guess?.id ?? null,
      };
    },
  }),
  defineAction({
    name: "notion.choose",
    description:
      "Pick the Notion task board to read and who you are on it. Its open tickets assigned to you come in as tasks on the next round.",
    input: z.object({
      board: z.string().min(1).max(100),
      you: z.string().min(1).max(100).nullable(),
    }),
    risk: "internal",
    callers: ["owner"],
    async handler(i, ctx) {
      const a = await account(ctx);
      const t = openToken(ctx, a);
      const schema = await ask(() => notionApi(ctx).schema(t, i.board));
      const columns = pickColumns(schema);
      let ownerName: string | null = null;
      if (columns.assignee) {
        if (!i.you) throw new ActionError("invalid_input", "Pick who you are in Notion.");
        const person = (await ask(() => notionApi(ctx).people(t))).find((p) => p.id === i.you);
        if (!person) throw new ActionError("invalid_input", "That person isn't in this workspace.");
        ownerName = person.name;
      }
      const same = a.sourceId === i.board && a.ownerUserId === (columns.assignee ? i.you : null);
      if (a.sourceId !== i.board) await forgetTickets(ctx, i.board);
      await ctx.tx
        .update(notionAccount)
        .set({
          sourceId: i.board,
          sourceTitle: schema.title,
          columns,
          ownerUserId: columns.assignee ? i.you : null,
          ownerName,
          // Someone else's board, or someone else on it, starts with a quiet first read again.
          ...(same ? {} : { syncedAt: null, ...healthy }),
        })
        .where(eq(notionAccount.botId, a.botId));
      return { board: schema.title, you: ownerName, columns };
    },
  }),
  defineAction({
    name: "notion.status",
    description:
      "Whether Notion is connected, the task board read, who you are on it, how many open tickets are yours and how syncing is going.",
    input: z.object({}),
    risk: "read",
    // Settings is its reader. The board's title, its column and status names and the workspace's
    // name are written by anyone who can edit the board, and nothing here marks them as outside
    // words, so Jarvis doesn't get them (D58), as with slack.status.
    callers: ["owner"],
    async handler(_i, ctx) {
      const [a] = await ctx.tx.select().from(notionAccount).limit(1);
      if (!a) return { connected: false };
      const [open] = await ctx.tx
        .select({ n: count() })
        .from(notionTask)
        .innerJoin(entity, eq(entity.id, notionTask.entityId))
        .where(openTicket);
      return {
        connected: true,
        workspace: a.workspace,
        board: a.sourceTitle,
        boardId: a.sourceId,
        you: a.ownerName,
        columns: a.columns,
        open: open?.n ?? 0,
        syncedAt: a.syncedAt,
        state: a.syncState,
        lastError: a.lastError,
      };
    },
  }),
  defineAction({
    name: "notion.disconnect",
    description: "Forget the Notion secret, the board and the tickets read in.",
    input: z.object({}),
    risk: "internal",
    callers: ["owner"],
    async handler(_i, ctx) {
      await forgetTickets(ctx, null);
      await ctx.tx.delete(notionAccount);
      await closeAlerts(ctx, "notion");
      return { disconnected: true };
    },
  }),
  defineAction({
    name: "notion.tasks",
    description:
      "Tickets assigned to you on your Notion task board, most recently edited first, with status, due date and link. Their text is written by other people.",
    input: z.object({
      limit: z.number().int().min(1).max(100).default(30),
      open: z.boolean().default(true),
    }),
    risk: "read",
    async handler(i, ctx) {
      const rows = await ctx.tx
        .select({
          id: notionTask.entityId,
          title: entity.title,
          status: notionTask.status,
          done: notionTask.done,
          dueAt: notionTask.dueAt,
          url: notionTask.url,
          editedAt: notionTask.editedAt,
        })
        .from(notionTask)
        .innerJoin(entity, eq(entity.id, notionTask.entityId))
        .where(i.open ? openTicket : and(eq(notionTask.assigned, true), isNull(entity.deletedAt)))
        .orderBy(desc(notionTask.editedAt))
        .limit(i.limit);
      return rows.map((r) => ({ ...r, type: "notion_task" }));
    },
  }),
  defineAction({
    name: "notion.sync",
    description: "Read your Notion task board now.",
    input: z.object({}),
    risk: "internal",
    // Only as the integration: tickets are outside content, never the owner's (D68).
    callers: ["integration"],
    handler: (_i, ctx) => syncNotion(ctx),
  }),
];
