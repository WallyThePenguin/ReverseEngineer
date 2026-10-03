// /api/push: turn phone notifications on or off for a device, and send yourself a test. Owner
// only; a paired desktop app can't reach it.
import { pushSubscription } from "@hearth/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireCaller } from "../auth/middleware.ts";
import type { AppEnv } from "../env.ts";
import { type PushSend, pushToAll, vapidKeys } from "../push.ts";

const subscribe = z.object({
  // Push services are public HTTPS endpoints.
  endpoint: z.string().url().startsWith("https://").max(1000),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
  label: z.string().trim().min(1).max(80).default("A device"),
});

export function pushRoutes(send: PushSend) {
  const app = new Hono<AppEnv>();
  app.use("*", requireCaller(["owner"]));

  app.get("/", async (c) => {
    const kernel = c.get("deps").kernel;
    const devices = await kernel.db
      .select({
        endpoint: pushSubscription.endpoint,
        label: pushSubscription.label,
        createdAt: pushSubscription.createdAt,
        lastSentAt: pushSubscription.lastSentAt,
      })
      .from(pushSubscription);
    return c.json({ publicKey: (await vapidKeys(kernel)).publicKey, devices });
  });

  app.post("/", async (c) => {
    const parsed = subscribe.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "That isn't a push subscription." }, 400);
    const { endpoint, keys, label } = parsed.data;
    await c
      .get("deps")
      .kernel.db.insert(pushSubscription)
      .values({ endpoint, p256dh: keys.p256dh, auth: keys.auth, label })
      .onConflictDoUpdate({
        target: pushSubscription.endpoint,
        set: { p256dh: keys.p256dh, auth: keys.auth, label },
      });
    return c.json({ ok: true });
  });

  app.delete("/", async (c) => {
    const endpoint = String(
      ((await c.req.json().catch(() => ({}))) as { endpoint?: string }).endpoint ?? "",
    );
    await c
      .get("deps")
      .kernel.db.delete(pushSubscription)
      .where(eq(pushSubscription.endpoint, endpoint));
    return c.json({ ok: true });
  });

  app.post("/test", async (c) => {
    const sent = await pushToAll(
      c.get("deps").kernel,
      {
        title: "Hearth",
        body: "Notifications work on this device.",
        url: "/settings",
        tag: "test",
      },
      send,
    );
    return c.json({ sent });
  });
  return app;
}
