// A savepoint inside an action's transaction: one record that fails to save (a malformed email,
// an odd calendar event) is undone on its own, and the action carries on with the rest.
import type { ActionContext, EmitEvent } from "./types.ts";

/**
 * Runs `fn` in a savepoint. If it throws, its writes and the events it emitted are undone and the
 * error is rethrown; the action's transaction stays usable. If it returns, both are kept.
 */
export async function savepoint<T>(
  ctx: ActionContext,
  fn: (ctx: ActionContext) => Promise<T>,
): Promise<T> {
  const emitted: EmitEvent[] = [];
  const result = await ctx.tx.transaction((tx) =>
    fn({ ...ctx, tx, emit: (e) => void emitted.push(e) }),
  );
  for (const e of emitted) ctx.emit(e);
  return result;
}
