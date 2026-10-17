// Changes in a data source (D73): a Convex deployment's own mutations and actions, run only on a
// source you've let Jarvis ask to change, and each only with your yes. The card shows the
// function, its args and the deployment, and a call whose source changed since is refused.
import { dataSource } from "@hearth/db";
import { ActionError, type Caller, defineAction, stableStringify } from "@hearth/kernel";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { capValue } from "./cap.ts";
import { ConvexError, deploymentName } from "./convex.ts";
import {
  convex,
  functionArgs,
  functionPath,
  keyOf,
  limits,
  type Source,
  said,
  source,
  sourceId,
} from "./shared.ts";

/** Where a change would land, as the card shows it. */
const where = z.object({
  label: z.string(),
  address: z.string(),
  deployment: z.string(),
  keyKind: z.string(),
});
type Where = z.infer<typeof where>;

const whereOf = (s: Source): Where => ({
  label: s.label,
  address: s.address,
  deployment: deploymentName(s.address) ?? s.address,
  keyKind: s.keyKind,
});

function allows(s: Source) {
  if (s.mode !== "approve_writes")
    throw new ActionError(
      "forbidden",
      `${s.label} is read-only. You can let Pip ask to make changes there in Settings, Data sources.`,
    );
}

/** The source is still where you were shown, and you were shown it. */
function same(given: Where | undefined, now: Where, caller: Caller) {
  if (given && stableStringify(given) !== stableStringify(now))
    throw new ActionError(
      "conflict",
      "The data source changed since you were asked, so nothing was changed.",
    );
  if (!given && caller.kind !== "owner")
    throw new ActionError(
      "conflict",
      "Nook couldn't show the owner where this would change, so nothing was changed.",
    );
}

/** A change that may have been made is never "try again": that could make it twice. */
const unsure = (err: unknown): never => {
  if (err instanceof ConvexError && err.kind === "unreachable")
    throw new ActionError(
      "unavailable",
      `${err.message} Nook can't tell whether the change was made, so look before asking again.`,
    );
  return said(err);
};

type ChangeInput = {
  source: string;
  kind: "mutation" | "action";
  path: string;
  args: Record<string, unknown>;
  snapshot?: Where;
};

export const changeActions = [
  defineAction({
    name: "data.set_mode",
    description:
      "Whether Pip only reads a data source (read) or may also ask to change it (approve_writes), each change on your yes.",
    input: z.object({ source: sourceId, mode: z.enum(["read", "approve_writes"]) }),
    risk: "internal",
    callers: ["owner"],
    async handler(i, ctx) {
      const s = await source(ctx, i.source);
      await ctx.tx.update(dataSource).set({ mode: i.mode }).where(eq(dataSource.id, s.id));
      ctx.emit({
        kind: "data.source_changed",
        payload: { sourceId: s.id, label: s.label, change: i.mode },
      });
      return { label: s.label, mode: i.mode };
    },
  }),
  defineAction({
    name: "data.change",
    description:
      "Change something in a data source by running one of its mutations or actions (data.functions lists them, on a source that allows changes) with its args. Every call asks the owner first, showing the function, its args and the deployment. The result is outside content, long values cut.",
    input: z.object({
      source: sourceId,
      // Convex holds to it: /api/mutation runs only mutations, /api/action only actions.
      kind: z.enum(["mutation", "action"]),
      path: functionPath,
      args: functionArgs,
      snapshot: where.optional(),
    }),
    risk: "outward",
    callers: ["owner", "agent"],
    external: true,
    io: true,
    async snapshot(i, ctx) {
      const s = await source(ctx, i.source);
      allows(s);
      return { snapshot: whereOf(s) };
    },
    // No Always allow: each change is shown to you on its own.
    summarize: (i: ChangeInput) => {
      const s = i.snapshot;
      const at = s ? `${s.label} (${s.deployment}, with a ${s.keyKind})` : i.source;
      const reach =
        i.kind === "action" ? "\n\nAn action can also reach beyond Convex, as its code says." : "";
      return `Run the ${i.kind} ${i.path} on ${at}${reach}\n\nArgs: ${JSON.stringify(i.args, null, 2)}`;
    },
    async handler(i, ctx) {
      const s = await source(ctx, i.source);
      allows(s);
      same(i.snapshot, whereOf(s), ctx.caller);
      const value = await convex(ctx)
        .change(s.address, keyOf(ctx, s), i.kind, i.path, i.args)
        .catch(unsure);
      const out = capValue(value, limits);
      return {
        source: s.label,
        kind: i.kind,
        path: i.path,
        value: out.value,
        truncated: out.truncated,
        outside: true,
      };
    },
  }),
];
