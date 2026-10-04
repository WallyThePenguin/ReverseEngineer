// Phone notifications (M6): approvals, the morning brief and interruptions Jarvis is allowed to
// make are pushed to every device that turned notifications on. Messages are end-to-end
// encrypted to the device (Web Push), so the push service only carries them.
import { event, notification, pushSubscription, setting } from "@hearth/db";
import { getSetting, type Kernel } from "@hearth/kernel";
import { and, eq, gt, inArray, lte, max } from "drizzle-orm";
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

export const webPushSend: PushSend = async (sub, message, vapid) => {
  try {
    await webpush.sendNotification(sub, JSON.stringify(message), {
      vapidDetails: { subject: SUBJECT, ...vapid },
      TTL: 6 * 60 * 60,
      urgency: "high",
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

/** Which inbox items are worth buzzing your phone for. */
export function worthPushing(p: Record<string, unknown>): boolean {
  if (p.kind === "approval" || p.kind === "brief") return true;
  return p.urgency === "interrupt" && p.delivered === true;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const HEADINGS: Record<string, string> = {
  approval: "Jarvis needs a yes",
  brief: "Your brief is ready",
};

export function messageFor(row: { id: string; kind: string; title: string; body: string | null }) {
  const heading = HEADINGS[row.kind];
  return {
    title: heading ?? clip(row.title, 120),
    body: clip(heading ? row.title : (row.body ?? ""), 240),
    url: "/inbox",
    tag: row.id,
  } satisfies PushMessage;
}

export async function pushToAll(kernel: Kernel, message: PushMessage, send: PushSend) {
  const subs = await kernel.db.select().from(pushSubscription);
  if (!subs.length) return 0;
  const vapid = await vapidKeys(kernel);
  let sent = 0;
  for (const s of subs) {
    const sub = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
    try {
      if (await send(sub, message, vapid)) {
        sent++;
        await kernel.db
          .update(pushSubscription)
          .set({ lastSentAt: new Date() })
          .where(eq(pushSubscription.endpoint, s.endpoint));
      } else {
        await kernel.db.delete(pushSubscription).where(eq(pushSubscription.endpoint, s.endpoint));
      }
    } catch (err) {
      console.warn(`Couldn't send a notification to ${s.label}: ${(err as Error).message}`);
    }
  }
  return sent;
}

/**
 * Watches the event log for new inbox items and pushes the ones worth it. It starts from the
 * newest event, so a restart never re-sends old ones.
 */
export function startPush(kernel: Kernel, hub: EventHub, send: PushSend = webPushSend) {
  let cursor: number | null = null;
  let running = Promise.resolve();
  const catchUp = async (upTo: number) => {
    if (cursor === null) {
      const [row] = await kernel.db.select({ seq: max(event.seq) }).from(event);
      cursor = Math.min(row?.seq ?? 0, upTo - 1);
    }
    if (upTo <= cursor) return;
    const created = await kernel.db
      .select({ seq: event.seq, payload: event.payload })
      .from(event)
      .where(
        and(
          // Delivered: an interrupt held for quiet hours that goes out in the morning (D54).
          inArray(event.kind, ["notification.created", "notification.delivered"]),
          gt(event.seq, cursor),
          lte(event.seq, upTo),
        ),
      );
    cursor = upTo;
    const ids = created
      .filter((e) => worthPushing(e.payload))
      .map((e) => String(e.payload.notificationId));
    if (!ids.length) return;
    const rows = await kernel.db.select().from(notification).where(inArray(notification.id, ids));
    for (const row of rows) await pushToAll(kernel, messageFor(row), send);
  };
  const unsubscribe = hub.subscribe({
    onEvents(seq) {
      running = running
        .then(() => catchUp(seq))
        .catch((err) => {
          console.warn(`Phone notifications: ${(err as Error).message}`);
        });
    },
    onStream() {},
  });
  return {
    stop: unsubscribe,
    /** Resolves once everything seen so far is handled (for tests). */
    idle: () => running,
  };
}
