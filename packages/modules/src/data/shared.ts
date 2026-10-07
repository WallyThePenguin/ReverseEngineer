// What the data module's actions share: a source's row and key, Convex's words as errors, and the
// inputs that name a source and one of its functions.
import { dataSource } from "@hearth/db";
import { type ActionContext, ActionError, type ReadContext } from "@hearth/kernel";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { VAULT_SERVICE, type Vault } from "../browser/vault.ts";
import { CONVEX_SERVICE, type ConvexApi, ConvexError, LIMITS, type Limits } from "./convex.ts";

export type Source = typeof dataSource.$inferSelect;
export type Raw = Record<string, unknown>;

/** How much comes back from a source: smaller in tests. */
export const limits: Limits = { ...LIMITS };

type Services = Pick<ActionContext, "service">;
export const convex = (ctx: Services) => ctx.service<ConvexApi>(CONVEX_SERVICE);
export const seal = (ctx: Services, id: string, key: string) =>
  ctx.service<Vault>(VAULT_SERVICE).seal("data", id, key);
export const keyOf = (ctx: Services, s: Source) =>
  ctx.service<Vault>(VAULT_SERVICE).open("data", s.id, s.secret);

export async function source(ctx: ActionContext | ReadContext, id: string): Promise<Source> {
  const db = "tx" in ctx ? ctx.tx : ctx.db;
  const [s] = await db.select().from(dataSource).where(eq(dataSource.id, id));
  if (!s) throw new ActionError("not_found", "There's no data source with that id (data.sources).");
  return s;
}

/** Convex's words as an error you can act on. */
export const said = (err: unknown): never => {
  if (!(err instanceof ConvexError)) throw err;
  throw new ActionError(err.kind === "unreachable" ? "unavailable" : "failed", err.message);
};

export const sourceId = z.string().uuid();
/** A function of the deployment's own: "messages:list", "admin/users:byEmail". */
export const functionPath = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(
    /^[A-Za-z0-9][\w\-./]*(:[A-Za-z_$][\w$]*)?$/,
    "A function's path is its file and name, like messages:list.",
  )
  .refine((p) => !p.includes(".."), "A function's path is its file and name, like messages:list.");
/** A function's args, as JSON. */
export const functionArgs = z
  .record(z.string(), z.unknown())
  .default({})
  .refine((a) => JSON.stringify(a).length <= 20_000, "The args are too long.");
