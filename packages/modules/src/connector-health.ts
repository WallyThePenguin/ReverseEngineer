// How a connector that polls with your token (Slack, GitHub) is syncing, saved after each round
// the way mail does it (D55, D61). A token that stops working stops the polling until you give
// Hearth a new one. Other failures alert only when they won't pass by themselves or keep
// happening (3 rounds in a row and nothing read for 30 minutes). Each run of failures is told
// once, when it starts, and the first good round closes the notice again.
import { localDate } from "@hearth/core";
import { type ConnectorSyncState, notification } from "@hearth/db";
import { type ActionContext, getSetting, type ReadContext, type ReflexDef } from "@hearth/kernel";
import { and, ne, sql } from "drizzle-orm";
import { FAILING_AFTER_MS, FAILURES_BEFORE_ALERT } from "./mail/sync-state.ts";

export interface Health {
  syncState: ConnectorSyncState;
  failures: number;
  failingSince: Date | null;
  syncedAt: Date | null;
}

/**
 * - revoked: the token no longer works; polling stops until it's replaced.
 * - refused: something that won't pass by itself (a repo the token can't see, a missing scope).
 * - transient: the network, a server error; it may pass if tried again.
 */
export interface Trouble {
  kind: "revoked" | "refused" | "transient";
  message: string;
}

/** The worst of a round's troubles, with all their messages. */
export function worst(troubles: Trouble[]): Trouble | null {
  if (!troubles.length) return null;
  const rank = { revoked: 2, refused: 1, transient: 0 };
  const kind = troubles.reduce((a, t) => (rank[t.kind] > rank[a] ? t.kind : a), troubles[0]!.kind);
  return { kind, message: troubles.map((t) => t.message).join("\n") };
}

export interface NextHealth {
  values: {
    syncState: ConnectorSyncState;
    failures: number;
    failingSince: Date | null;
    lastError: string | null;
    syncedAt?: Date;
  };
  /** This round starts a run of failures worth telling, or the token just stopped working. */
  alert: { since: Date; reconnect: boolean } | null;
  /** A good round after failures: the notice can close. */
  recovered: boolean;
}

/** What to save after a round. `progressed`: something was read, even if not everything. */
export function nextHealth(
  h: Health,
  now: Date,
  trouble: Trouble | null,
  progressed: boolean,
): NextHealth {
  const read = progressed ? { syncedAt: now } : {};
  if (!trouble)
    return {
      values: { syncState: "ok", failures: 0, failingSince: null, lastError: null, syncedAt: now },
      alert: null,
      recovered: h.failures > 0 || h.syncState !== "ok",
    };
  const failures = h.failures + 1;
  const since = h.failingSince ?? now;
  const quietFor = progressed ? 0 : now.getTime() - (h.syncedAt?.getTime() ?? 0);
  const failing =
    trouble.kind !== "transient" ||
    (failures >= FAILURES_BEFORE_ALERT && quietFor >= FAILING_AFTER_MS);
  const syncState: ConnectorSyncState =
    trouble.kind === "revoked"
      ? "revoked"
      : failing || h.syncState === "failing"
        ? "failing"
        : h.syncState;
  return {
    values: {
      syncState,
      failures,
      failingSince: since,
      lastError: trouble.message.slice(0, 1000),
      ...read,
    },
    alert:
      syncState !== h.syncState && syncState !== "ok"
        ? { since, reconnect: syncState === "revoked" }
        : null,
    recovered: false,
  };
}

/** The notice for one run of failures; a token that stops working mid-run gets its own. */
export const alertKey = (module: string, since: Date | string, reconnect: boolean) =>
  `${module}.sync_failed:${new Date(since).toISOString()}${reconnect ? ":reconnect" : ""}`;

/** Marks the connector's open "isn't syncing" notices done: it syncs again, or it's gone. */
export async function closeAlerts(ctx: ActionContext, module: string) {
  const rows = await ctx.tx
    .update(notification)
    .set({ state: "done", updatedAt: ctx.now })
    .where(
      and(
        ne(notification.state, "done"),
        sql`starts_with(${notification.dedupeKey}, ${`${module}.sync_failed:`})`,
      ),
    )
    .returning({ id: notification.id, entityId: notification.entityId });
  for (const r of rows)
    ctx.emit({
      kind: "notification.updated",
      entityId: r.entityId,
      payload: { notificationId: r.id, state: "done" },
    });
}

/**
 * The reflex that tells you a connector stopped syncing. `failingSince` reads when the current
 * run of failures started, so an alert Jarvis gets to late, after the sync that closed it, stays
 * unsaid.
 */
export function syncFailedReflex(
  module: string,
  label: string,
  failingSince: (ctx: ReadContext) => Promise<Date | null | undefined>,
): ReflexDef {
  return {
    name: `${module}.sync_failed`,
    description: `When ${label} stops syncing (a token to replace, or failing for half an hour), you get one notice, closed again once it syncs.`,
    mode: "always",
    on: [`${module}.sync_failed`],
    async run(event, ctx) {
      const p = event.payload;
      const errors = (p.errors as string[] | undefined) ?? (p.error ? [String(p.error)] : []);
      const since = typeof p.since === "string" ? p.since : null;
      if (since && (await failingSince(ctx))?.toISOString() !== since) return [];
      const what = p.reconnect
        ? `${label} stopped accepting Hearth's token. Paste a new one in Settings; reading waits until then.`
        : `Hearth hasn't been able to read ${label} for a while. It keeps trying every few minutes.`;
      const dedupeKey = since
        ? alertKey(module, since, Boolean(p.reconnect))
        : `${module}.sync_failed:${localDate(event.at, (await getSetting(ctx.db, "owner.dayRules")).timeZone)}`;
      return [
        {
          kind: "tell",
          notification: {
            kind: "system.alert",
            title: `${label} isn't syncing`,
            body: [what, ...errors].join("\n").slice(0, 1000),
            urgency: "normal",
            dedupeKey,
          },
        },
      ];
    },
  };
}
