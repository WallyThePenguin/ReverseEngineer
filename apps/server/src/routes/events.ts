// GET /api/events: a live feed of everything that happens in Hearth, for open screens.
// Replays from Last-Event-ID (or ?after=) and then streams, so a reconnect never misses an event.
import { latestSeq, readEventsAfter } from "@hearth/kernel";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { requireCaller } from "../auth/middleware.ts";
import { checkToken } from "../auth/tokens.ts";
import type { AppEnv } from "../env.ts";

/** How often the feed says it's alive, and checks the session it was opened with still is. */
const KEEP_ALIVE_MS = 20_000;
/** How long a browser waits before connecting again after the feed drops. */
const RETRY_MS = 2_000;

export function eventRoutes(keepAliveMs = KEEP_ALIVE_MS) {
  const app = new Hono<AppEnv>();
  app.get("/", requireCaller(["owner"]), (c) => {
    const { kernel, hub } = c.get("deps");
    const token = c.get("token");
    const fromHeader = Number(c.req.header("last-event-id"));
    const fromQuery = Number(c.req.query("after"));
    const start = Number.isFinite(fromHeader) && fromHeader > 0 ? fromHeader : fromQuery;
    return streamSSE(c, async (stream) => {
      let cursor = Number.isFinite(start) && start >= 0 ? start : await latestSeq(kernel.db);
      let pumping: Promise<void> | null = null;
      let again = false;

      const pump = async () => {
        do {
          again = false;
          for (;;) {
            const events = await readEventsAfter(kernel.db, cursor, { limit: 200 });
            for (const e of events) {
              await stream.writeSSE({ event: "event", id: String(e.seq), data: JSON.stringify(e) });
              cursor = e.seq;
            }
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

      const unsubscribe = hub.subscribe({
        onEvents: (seq) => {
          if (seq > cursor) wake();
        },
        onStream: (payload) =>
          void stream.writeSSE({ event: "stream", data: payload }).catch(() => {}),
        onStop: () => stream.abort(),
      });
      // A named event, not a comment, so the page can tell a quiet feed from a dead one. A
      // session that ended (signed out, revoked, expired) ends its feed too. Watching doesn't
      // count as using it, so an open tab alone never keeps a session alive.
      const keepAlive = setInterval(() => {
        void stream.writeSSE({ event: "ping", data: "{}" }).catch(() => {});
        if (!token) return;
        void checkToken(kernel.db, token, new Date(), { touch: false })
          .then((r) => {
            if (!r.ok) stream.abort();
          })
          // The database being out of reach doesn't end anyone's session.
          .catch(() => {});
      }, keepAliveMs);
      const done = new Promise<void>((resolve) => stream.onAbort(resolve));

      await stream.writeSSE({
        event: "ready",
        data: JSON.stringify({ after: cursor }),
        retry: RETRY_MS,
      });
      wake();
      await done;
      clearInterval(keepAlive);
      unsubscribe();
      await pumping;
    });
  });
  return app;
}
