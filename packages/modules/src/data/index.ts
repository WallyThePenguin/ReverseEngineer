// Data connectors (D73): outside data Jarvis may read, connected in Settings with a key you give
// Hearth, a Convex deployment first. What comes back is outside content, as an email is: it makes
// the rest of Jarvis's turn untrusted, so anything outward after it asks you first.
import { dataSource } from "@hearth/db";
import {
  type ActionContext,
  ActionError,
  defineAction,
  type HearthModule,
  newId,
} from "@hearth/kernel";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { VAULT_SERVICE, type Vault } from "../browser/vault.ts";
import { capValue } from "./cap.ts";
import {
  CONVEX_SERVICE,
  type ConvexApi,
  ConvexError,
  deploymentAddress,
  deploymentName,
  describeKey,
  LIMITS,
  type Limits,
} from "./convex.ts";

export { CONVEX_SERVICE, type ConvexApi, FakeConvex, httpConvex } from "./convex.ts";

type Source = typeof dataSource.$inferSelect;
type Raw = Record<string, unknown>;

/** How much comes back from a source: smaller in tests. */
export const limits: Limits = { ...LIMITS };
/** The most documents one call reads. */
const PAGE = 100;
/** The most tables listed. */
const TABLES = 500;

const convex = (ctx: Pick<ActionContext, "service">) => ctx.service<ConvexApi>(CONVEX_SERVICE);
const seal = (ctx: Pick<ActionContext, "service">, id: string, key: string) =>
  ctx.service<Vault>(VAULT_SERVICE).seal("data", id, key);
const keyOf = (ctx: Pick<ActionContext, "service">, s: Source) =>
  ctx.service<Vault>(VAULT_SERVICE).open("data", s.id, s.secret);

async function source(ctx: ActionContext, id: string): Promise<Source> {
  const [s] = await ctx.tx.select().from(dataSource).where(eq(dataSource.id, id));
  if (!s) throw new ActionError("not_found", "There's no data source with that id (data.sources).");
  return s;
}

/** Convex's words as an error you can act on. */
const said = (err: unknown): never => {
  if (!(err instanceof ConvexError)) throw err;
  throw new ActionError(err.kind === "unreachable" ? "unavailable" : "failed", err.message);
};

/** Runs one of the source's queries with its key. */
async function ask(ctx: ActionContext, s: Source, path: string, args: Raw): Promise<unknown> {
  return convex(ctx).query(s.address, keyOf(ctx, s), path, args).catch(said);
}

/** The key works there: one table name, through the call data.tables makes. */
const tryKey = (ctx: ActionContext, address: string, key: string) =>
  convex(ctx).query(address, key, "_system/cli/tables", {
    paginationOpts: { numItems: 1, cursor: null },
  });

interface Page {
  page: unknown[];
  isDone: boolean;
  continueCursor: string;
}

/** A page of a system function's results, as the Convex CLI reads them (they aren't documented). */
function pageOf(value: unknown): Page {
  const p = value as Partial<Page> | null;
  if (!p || !Array.isArray(p.page))
    throw new ActionError(
      "failed",
      "Convex answered in a shape Hearth doesn't know. Its API may have changed.",
    );
  return {
    page: p.page,
    isDone: p.isDone !== false,
    continueCursor: String(p.continueCursor ?? ""),
  };
}

/** A function as Convex's spec lists it, in the shape Jarvis calls it by. */
function readSpec(raw: unknown): { path: string; type: string; visibility: string; args: unknown } {
  const f = (raw ?? {}) as Raw;
  const vis = f.visibility as Raw | string | undefined;
  let args = f.args;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {}
  }
  return {
    // "messages.js:list" is called as "messages:list".
    path: String(f.identifier ?? "").replace(/\.[jt]s(?=:|$)/, ""),
    type: String(f.functionType ?? "").toLowerCase(),
    visibility: typeof vis === "string" ? vis : String(vis?.kind ?? "public"),
    args,
  };
}

/** The tables and their declared shapes, through the system functions the Convex CLI calls. */
async function listTables(ctx: ActionContext, s: Source) {
  const names: string[] = [];
  let cursor: string | null = null;
  // One past the cap, so a list cut short says so.
  while (names.length <= TABLES) {
    const p = pageOf(
      await ask(ctx, s, "_system/cli/tables", {
        paginationOpts: { numItems: TABLES + 1 - names.length, cursor },
      }),
    );
    names.push(...p.page.map((t) => String((t as Raw).name)));
    if (p.isDone || p.page.length === 0) break;
    cursor = p.continueCursor;
  }
  // A deployment without a schema has none to tell; its documents show their shape.
  const declared = new Map<string, unknown>();
  const schemas = (await ask(ctx, s, "_system/frontend/getSchemas", {}).catch(() => null)) as {
    active?: string;
  } | null;
  try {
    const active = JSON.parse(schemas?.active ?? "{}") as { tables?: Raw[] };
    for (const t of active.tables ?? []) declared.set(String(t.tableName), t.documentType);
  } catch {}
  return names.map((name) => ({ name, shape: declared.get(name) ?? null }));
}

const sourceId = z.string().uuid();
/** A function of the deployment's own: "messages:list", "admin/users:byEmail". */
const functionPath = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(
    /^[A-Za-z0-9][\w\-./]*(:[A-Za-z_$][\w$]*)?$/,
    "A function's path is its file and name, like messages:list.",
  )
  .refine((p) => !p.includes(".."), "A function's path is its file and name, like messages:list.");

export const dataModule: HearthModule = {
  name: "data",
  description: "Outside data Jarvis can read when asked: a Convex deployment, with its key.",
  entityTypes: [],
  events: [
    {
      kind: "data.source_changed",
      description:
        "A data source was connected, checked or removed. Payload: sourceId, label, change.",
    },
  ],
  knowledge: {},
  reflexes: [],
  noReflexesBecause:
    "A data source is read when you or Jarvis ask; nothing in it is watched for changes.",
  actions: [
    defineAction({
      name: "data.connect",
      description:
        "Connect a Convex deployment for Jarvis to read, with its URL and a deploy key, which is sealed.",
      input: z.object({
        label: z.string().trim().min(1).max(60),
        address: z.string().trim().min(1).max(300),
        key: z.string().trim().min(10).max(2000),
      }),
      // Only you, from Settings; the audit log keeps none of it.
      risk: "secret",
      callers: ["owner"],
      async handler(i, ctx) {
        const address = (() => {
          try {
            return deploymentAddress(i.address);
          } catch (err) {
            return said(err);
          }
        })();
        const key = describeKey(i.key);
        const name = deploymentName(address);
        if (key.deployment && name && key.deployment !== name)
          throw new ActionError(
            "invalid_input",
            `That key is for the deployment ${key.deployment}, not ${name}.`,
          );
        const [taken] = await ctx.tx
          .select({ id: dataSource.id })
          .from(dataSource)
          .where(eq(dataSource.label, i.label));
        if (taken) throw new ActionError("conflict", `There's already a source named ${i.label}.`);
        await tryKey(ctx, address, i.key).catch(said);
        const id = newId();
        await ctx.tx.insert(dataSource).values({
          id,
          label: i.label,
          kind: "convex",
          mode: "read",
          address,
          secret: seal(ctx, id, i.key),
          keyKind: key.kind,
          checkedAt: ctx.now,
        });
        ctx.emit({
          kind: "data.source_changed",
          payload: { sourceId: id, label: i.label, change: "connected" },
        });
        return { id, label: i.label, address, keyKind: key.kind, production: key.production };
      },
    }),
    defineAction({
      name: "data.status",
      description:
        "Every data source with its address, what its key is, when it was last checked and what's wrong, if anything.",
      input: z.object({}),
      risk: "read",
      // Settings is its reader: a problem is told in the source's own words, which aren't marked
      // as outside words here, so Jarvis doesn't get them (D58).
      callers: ["owner"],
      async handler(_i, ctx) {
        const rows = await ctx.tx.select().from(dataSource).orderBy(asc(dataSource.label));
        return rows.map(({ secret: _secret, ...s }) => s);
      },
    }),
    defineAction({
      name: "data.check",
      description: "Check a data source's key again, after it was changed or revoked there.",
      input: z.object({ source: sourceId }),
      risk: "internal",
      callers: ["owner"],
      async handler(i, ctx) {
        const s = await source(ctx, i.source);
        const why = await tryKey(ctx, s.address, keyOf(ctx, s)).then(
          () => null,
          (err: unknown) => (err instanceof ConvexError ? err.message : said(err)),
        );
        await ctx.tx
          .update(dataSource)
          .set({ checkedAt: ctx.now, lastError: why })
          .where(eq(dataSource.id, s.id));
        ctx.emit({
          kind: "data.source_changed",
          payload: { sourceId: s.id, label: s.label, change: "checked" },
        });
        return { ok: !why, problem: why };
      },
    }),
    defineAction({
      name: "data.disconnect",
      description: "Forget a data source and its key. Nothing changes at the source.",
      input: z.object({ source: sourceId }),
      risk: "internal",
      callers: ["owner"],
      async handler(i, ctx) {
        const s = await source(ctx, i.source);
        await ctx.tx.delete(dataSource).where(eq(dataSource.id, s.id));
        ctx.emit({
          kind: "data.source_changed",
          payload: { sourceId: s.id, label: s.label, change: "removed" },
        });
        return { removed: s.label };
      },
    }),
    defineAction({
      name: "data.sources",
      description:
        "The outside data you can read: id, your name for each, its kind and address. Read one with data.tables, data.documents, data.functions and data.query.",
      input: z.object({}),
      risk: "read",
      async handler(_i, ctx) {
        return ctx.tx
          .select({
            id: dataSource.id,
            label: dataSource.label,
            kind: dataSource.kind,
            address: dataSource.address,
          })
          .from(dataSource)
          .orderBy(asc(dataSource.label));
      },
    }),
    defineAction({
      name: "data.tables",
      description:
        "A data source's tables, each with its shape: inferred from its documents where the deployment has Convex's streaming export, otherwise the one its schema declares, if any. Their names are written by the deployment's makers.",
      input: z.object({ source: sourceId }),
      risk: "read",
      external: true,
      io: true,
      async handler(i, ctx) {
        const s = await source(ctx, i.source);
        // The streaming export knows every table's shape from its documents; without it, the
        // tables come from the calls the Convex CLI makes, with the shapes the schema declares.
        const exported = await convex(ctx).shapes(s.address, keyOf(ctx, s));
        const tables = exported
          ? Object.entries(exported).map(([name, shape]) => ({ name, shape }))
          : await listTables(ctx, s);
        const out = capValue(tables.slice(0, TABLES), limits);
        const more = tables.length > TABLES;
        return {
          source: s.label,
          tables: out.value,
          truncated: out.truncated || more,
          outside: true,
        };
      },
    }),
    defineAction({
      name: "data.documents",
      description: `A page of one table's documents, newest first unless asked otherwise, at most ${PAGE} at a time, long values cut. Pass back \`cursor\` for the next page. The documents are outside content.`,
      input: z.object({
        source: sourceId,
        table: z.string().trim().min(1).max(200),
        cursor: z.string().min(1).max(2000).optional(),
        limit: z.number().int().min(1).max(PAGE).default(25),
        order: z.enum(["desc", "asc"]).default("desc"),
      }),
      risk: "read",
      external: true,
      io: true,
      async handler(i, ctx) {
        const s = await source(ctx, i.source);
        const p = pageOf(
          await ask(ctx, s, "_system/cli/tableData", {
            table: i.table,
            order: i.order,
            paginationOpts: { numItems: i.limit, cursor: i.cursor ?? null },
          }),
        );
        const out = capValue(p.page.slice(0, i.limit), limits);
        const documents = out.value as unknown[];
        // Cut short by size: the next page would skip what wasn't shown, so there's none.
        const cut = documents.length < Math.min(p.page.length, i.limit);
        return {
          source: s.label,
          table: i.table,
          documents,
          cursor: p.isDone || cut ? null : p.continueCursor,
          truncated: out.truncated,
          ...(cut && {
            note: `Only ${documents.length} fit. Ask again from the same cursor with a smaller limit.`,
          }),
          outside: true,
        };
      },
    }),
    defineAction({
      name: "data.functions",
      description:
        "A data source's query functions, which data.query runs: each one's path and the args it takes.",
      input: z.object({ source: sourceId }),
      risk: "read",
      external: true,
      io: true,
      async handler(i, ctx) {
        const s = await source(ctx, i.source);
        const spec = await ask(ctx, s, "_system/cli/modules:apiSpec", {});
        const queries = (Array.isArray(spec) ? spec : [])
          .map(readSpec)
          .filter((f) => f.type === "query" && f.path)
          .map(({ type: _type, ...f }) => f);
        const out = capValue(queries, limits);
        return { source: s.label, functions: out.value, truncated: out.truncated, outside: true };
      },
    }),
    defineAction({
      name: "data.query",
      description:
        "Run one of a data source's query functions (data.functions lists them) with its args. A Convex query only reads, whatever it's written to do. The result is outside content, long values cut.",
      input: z.object({
        source: sourceId,
        path: functionPath,
        args: z
          .record(z.string(), z.unknown())
          .default({})
          .refine((a) => JSON.stringify(a).length <= 20_000, "The args are too long."),
      }),
      risk: "read",
      external: true,
      io: true,
      async handler(i, ctx) {
        const s = await source(ctx, i.source);
        const out = capValue(await ask(ctx, s, i.path, i.args), limits);
        return { source: s.label, value: out.value, truncated: out.truncated, outside: true };
      },
    }),
  ],
};
