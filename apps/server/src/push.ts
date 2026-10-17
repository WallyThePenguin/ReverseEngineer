// Phone notifications (M6): approvals, the morning brief and interruptions Jarvis is allowed to
// make are pushed to every device that turned notifications on. Messages are end-to-end
// encrypted to the device (Web Push), so the push service only carries them.
import { isQuietHours } from "@hearth/core";
import { consumerCursor, event, notification, pushSubscription, setting } from "@hearth/db";
import { getSetting, type Kernel, latestSeq, setCursor } from "@hearth/kernel";
import { and, eq, gt, inArray, lte } from "drizzle-orm";
import webpush from "web-push";
import type { EventHub } from "./hub.ts";

export interface PushMessage {
  title: string;
  body: string;
  url: string;
  tag: string;
}

export interface Subscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Sends one message; resolves to false when the device is gone for good. */
export type PushSend = (
  sub: Subscription,
  message: PushMessage,
  vapid: { publicKey: string; privateKey: string },
) => Promise<boolean>;

const SUBJECT = process.env.HEARTH_PUSH_SUBJECT ?? "mailto:hearth@example.com";
/** A push service that hasn't answered by now isn't going to; the others still get theirs. */
export const SEND_TIMEOUT_MS = 10_000;
/** How long a push service keeps a message for a phone that's off; older ones aren't sent. */
const TTL_S = 6 * 60 * 60;

export const webPushSend: PushSend = async (sub, message, vapid) => {
  try {
    await webpush.sendNotification(sub, JSON.stringify(message), {
      vapidDetails: { subject: SUBJECT, ...vapid },
      TTL: TTL_S,
      urgency: "high",
      timeout: SEND_TIMEOUT_MS,
    });
    return true;
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    // Gone or unknown: the device turned notifications off or the app was removed.
    if (status === 404 || status === 410) return false;
    throw err;
  }
};

/** The signing keys, made the first time they're needed. */
export async function vapidKeys(kernel: Kernel) {
  const saved = await getSetting(kernel.db, "push.vapid");
  if (saved) return saved;
  // Two first requests at once: the first key pair written wins, and both read it back.
  await kernel.db
    .insert(setting)
    .values({ key: "push.vapid", value: webpush.generateVAPIDKeys() })
    .onConflictDoNothing();
  return (await getSetting(kernel.db, "push.vapid"))!;
}

/**
 * The events that can bring an inbox item worth a notification: a new one, and an interrupt held
 * for quiet hours that goes out in the morning (D54). The phone and the desktop app read both.
 */
export const PUSH_KINDS = ["notification.created", "notification.delivered"];

/** Which inbox items are worth buzzing your phone for. */
export function worthPushing(p: Record<string, unknown>): boolean {
  if (p.kind === "approval" || p.kind === "brief" || p.kind === "wrap") return true;
  return p.urgency === "interrupt" && p.delivered === true;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const HEADINGS: Record<string, string> = {
  approval: "Pip needs a yes",
  brief: "Your brief is ready",
};

/**
 * Where tapping it opens; anything else opens the inbox. An approval opens on Today's Needs you,
 * which says when a send reaches someone who isn't in its conversation; the brief and the evening
 * card open there too, each in full with the rest of your day.
 */
const OPENS: Record<string, string> = {
  approval: "/today",
  brief: "/today",
  wrap: "/today",
};

export function messageFor(row: { id: string; kind: string; title: string; body: string | null }) {
  const heading = HEADINGS[row.kind];
  return {
    title: heading ?? clip(row.title, 120),
    body: clip(heading ? row.title : (row.body ?? ""), 240),
    url: OPENS[row.kind] ?? "/inbox",
    tag: row.id,
  } satisfies PushMessage;
}

/** A send that gives up after `ms`, so one stuck push service can't hold up the rest. */
function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${ms / 1000} s`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** Sends to every device at once; resolves to how many took it. */
export async function pushToAll(
  kernel: Kernel,
  message: PushMessage,
  send: PushSend,
  timeoutMs = SEND_TIMEOUT_MS,
) {
  const subs = await kernel.db.select().from(pushSubscription);
  if (!subs.length) return 0;
  const vapid = await vapidKeys(kernel);
  const results = await Promise.allSettled(
    subs.map(async (s) => {
      const sub = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
      try {
        if (await within(timeoutMs, send(sub, message, vapid))) {
          await kernel.db
            .update(pushSubscription)
            .set({ lastSentAt: new Date() })
            .where(eq(pushSubscription.endpoint, s.endpoint));
          return true;
        }
        await kernel.db.delete(pushSubscription).where(eq(pushSubscription.endpoint, s.endpoint));
        return false;
      } catch (err) {
        console.warn(
          `[push] couldn't send a notification to ${s.label}: ${(err as Error).message}`,
        );
        return false;
      }
    }),
  );
  return results.filter((r) => r.status === "fulfilled" && r.value).length;
}

/** Where the push watcher is in the event log, kept across restarts. */
export const PUSH_CURSOR = "server.push";

/**
 * Watches the event log for new inbox items and pushes the ones worth it. Where it got to is
 * saved, so items raised while the server was down (an update, a crash) still go out when it's
 * back, unless they're older than a push service would keep them, or already dealt with. The
 * very first start begins at the newest event, so old items are never sent. The place moves on
 * only once the sends were tried, so a database error means a retry, not a lost push.
 */
export function startPush(
  kernel: Kernel,
  hub: EventHub,
  send: PushSend = webPushSend,
  opts: { timeoutMs?: number } = {},
) {
  let cursor: number | null = null;
  /** The newest seq known to be committed. */
  let target = 0;
  let pumping: Promise<void> | null = null;
  let stopped = false;

  const startAt = async () => {
    const [saved] = await kernel.db
      .select({ seq: consumerCursor.seq })
      .from(consumerCursor)
      .where(eq(consumerCursor.consumer, PUSH_CURSOR));
    if (saved) return saved.seq;
    const newest = await latestSeq(kernel.db);
    await setCursor(kernel.db, PUSH_CURSOR, newest);
    return newest;
  };

  const sendBatch = async (from: number, upTo: number) => {
    const created = await kernel.db
      .select({ seq: event.seq, payload: event.payload })
      .from(event)
      .where(and(inArray(event.kind, PUSH_KINDS), gt(event.seq, from), lte(event.seq, upTo)));
    const ids = created
      .filter((e) => worthPushing(e.payload))
      .map((e) => String(e.payload.notificationId));
    if (!ids.length) return;
    const oldest = new Date(kernel.clock.now().getTime() - TTL_S * 1000);
    const rows = await kernel.db.select().from(notification).where(inArray(notification.id, ids));
    const rules = await getSetting(kernel.db, "owner.dayRules");
    for (const row of rows) {
      // Answered on another screen, or too old to be news.
      if (row.state === "done" || (row.deliveredAt ?? row.createdAt) < oldest) continue;
      // "Your day" from a late run waits in the inbox rather than buzzing you at night.
      if (row.kind === "wrap" && isQuietHours(kernel.clock.now(), rules)) continue;
      await pushToAll(kernel, messageFor(row), send, opts.timeoutMs);
    }
  };

  const pump = async () => {
    if (cursor === null) {
      cursor = await startAt();
      // What came in while the server was down goes out now, not at the next event.
      target = Math.max(target, await latestSeq(kernel.db));
    }
    while (!stopped && target > cursor) {
      const upTo = target;
      await sendBatch(cursor, upTo);
      await setCursor(kernel.db, PUSH_CURSOR, upTo);
      cursor = upTo;
    }
  };

  // One pass at a time; events that arrive meanwhile only raise the target, so a burst is one
  // read, not one chain link per event.
  const wake = (seq: number) => {
    target = Math.max(target, seq);
    if (pumping || stopped) return;
    pumping = pump().then(
      () => {
        pumping = null;
        // Arrived just as the pass ended.
        if (cursor !== null && target > cursor) wake(target);
      },
      (err) => {
        pumping = null;
        // Not retried at once (that would spin while the database is down): the next event or
        // the catch-up after LISTEN comes back tries again from the same place.
        console.warn(`[push] phone notifications: ${(err as Error).message}`);
      },
    );
  };

  const unsubscribe = hub.subscribe({ onEvents: wake, onStream() {} });
  wake(0);
  return {
    stop() {
      stopped = true;
      unsubscribe();
    },
    /** Resolves once everything seen so far is handled (for tests). */
    async idle() {
      while (pumping) await pumping;
    },
  };
}
