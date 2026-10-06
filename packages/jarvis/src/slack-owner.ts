// A turn your Slack DM with Jarvis started tells Slack how it ended (D62): "Done", or "Needs your
// yes in Hearth" when something it did waits for you there, or that it didn't work. The answer
// itself stays in Hearth unless you turned full answers on (slack.bot.ownerDmAnswers): Slack keeps
// and exports what's posted there. The reply is an outbox row (slack.owner_reply, keyed by the
// turn), so the worker sends it once, even if this process stops right after.
import { systemCaller } from "@hearth/kernel";
import type { EndEnv, Ending } from "./turn-end.ts";

/** How a turn ended, as Slack hears it; null when it says nothing (retrying, stopped, skipped). */
export function endedAs(e: Ending, status: string, outcome: string | null) {
  if (status === "failed") return "failed" as const;
  if (status !== "done") return null;
  // Something waiting for your yes is what you need to hear, whatever else got done.
  const waits = outcome === "ask" || e.calls.some((c) => c.status === "pending_approval");
  return waits ? ("ask" as const) : ("done" as const);
}

export async function tellSlack(
  env: EndEnv,
  e: Ending,
  status: string,
  outcome: string | null,
  reply: string | null,
): Promise<void> {
  const ended = endedAs(e, status, outcome);
  if (!ended) return;
  const res = await env.kernel.execute(
    "slack.owner_reply",
    { turnId: e.turn.id, ended, answer: reply },
    systemCaller({ correlationId: e.turn.id }),
  );
  if (res.status !== "ok") env.log(`turn ${e.turn.id}: Slack wasn't told how it ended`, res);
}
