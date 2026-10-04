// GET /api/desktop/notify: what the desktop app shows as Windows notifications (D53). The inbox
// items your phone is told about (push.ts decides which) and Hearth's health changing, as
// server-sent events. The desktop app's token may read it; nothing here can approve anything,
// and a notification only opens a page.
import { notification } from "@hearth/db";
import { type HearthEvent, latestSeq, readEventsAfter } from "@hearth/kernel";
import { inArray } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { requireCaller } from "../auth/middleware.ts";
import type { AppEnv, ServerDeps } from "../env.ts";
import { messageFor, type PushMessage, worthPushing } from "../push.ts";

const KEEP_ALIVE_MS = 20_000;
/** A reconnect catches up on what it missed, but nothing older than this: it's news, not a log. */
const REPLAY_MS = 10 * 60_000;
const KINDS = ["notification.created", "system.health_changed"];

const NAMES: Record<string, string> = {
  worker: "Hearth's worker",
  jarvis: "Jarvis",
  backup: "Backups",
  disk: "Disk space",
};

/** A health change worth a notification: trouble starting, or trouble ending. */
export function healthMessage(p: Record<string, unknown>, seq: number): PushMessage | null {
  const component = String(p.component ?? "");
  const name = NAMES[component] ?? component;
  const tag = `health:${component}:${seq}`;
  if (p.status === "ok") {
    if (p.previous !== "degraded" && p.previous !== "failing") return null;
    return { title: `${name}: working again`, body: "", url: "/settings", tag };
  }
  return {
    title: p.status === "failing" ? `${name} isn't working` : `${name} needs a look`,
    body: "Open Hearth's Settings to see what's wrong.",
    url: "/settings",
    tag,
  };
}

/** The notifications in a batch of events, in order. */
export async function messagesFor(
  db: ServerDeps["kernel"]["db"],
  events: HearthEvent[],
  now: number,
): Promise<{ seq: number; message: PushMessage }[]> {
  const fresh = events.filter((e) => now - e.at.getTime() <= REPLAY_MS);
  const ids = fresh
    .filter((e) => e.kind === "notification.created" && worthPushing(e.payload))
    .map((e) => String(e.payload.notificationId));
  const rows = ids.length
    ? await db.select().from(notification).where(inArray(notification.id, ids))
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: { seq: number; message: PushMessage }[] = [];
  for (const e of fresh) {
    if (e.kind === "system.health_changed") {
      const message = healthMessage(e.payload, e.seq);
      if (message) out.push({ seq: e.seq, message });
    } else {
      const row = byId.get(String(e.payload.notificationId));
      if (row) out.push({ seq: e.seq, message: messageFor(row) });
    }
  }
  return out;
}

export function desktopRoutes() {
  const app = new Hono<AppEnv>();
  app.get("/notify", requireCaller(["owner"]), (c) => {
    const deps = c.get("deps");
    const header = c.req.header("last-event-id");
    const from = header ? Number(header) : Number.NaN;
    return streamSSE(c, async (stream) => {
      const latest = await latestSeq(deps.kernel.db);
      // Picks up after the last event this app saw, if it's one Hearth has; otherwise from now.
      let cursor = Number.isInteger(from) && from >= 0 && from <= latest ? from : latest;
      let pumping: Promise<void> | null = null;
      let again = false;

      const pump = async () => {
        do {
          again = false;
          for (;;) {
            const events = await readEventsAfter(deps.kernel.db, cursor, {
              limit: 200,
              kinds: KINDS,
            });
            const now = deps.kernel.clock.now().getTime();
            for (const { seq, message } of await messagesFor(deps.kernel.db, events, now)) {
              await stream.writeSSE({
                event: "notify",
                id: String(seq),
                data: JSON.stringify(message),
              });
            }
            if (events.length) cursor = events[events.length - 1]!.seq;
            if (events.length < 200 || stream.aborted) break;
          }
        } while (again && !stream.aborted);
      };
      const wake = () => {
        if (pumping) {
          again = true;
          return;
        }
        pumping = pump()
          .catch(() => stream.abort())
          .finally(() => {
            pumping = null;
          });
      };

      const unsubscribe = deps.hub.subscribe({
        onEvents: (seq) => {
          if (seq > cursor) wake();
        },
        onStream: () => {},
        onStop: () => stream.abort(),
      });
      const keepAlive = setInterval(
        () => void stream.write(": keep-alive\n\n").catch(() => {}),
        KEEP_ALIVE_MS,
      );
      const done = new Promise<void>((resolve) => stream.onAbort(resolve));

      await stream.writeSSE({ event: "ready", id: String(cursor), data: "{}" });
      wake();
      await done;
      clearInterval(keepAlive);
      unsubscribe();
      await pumping;
    });
  });
  return app;
}
