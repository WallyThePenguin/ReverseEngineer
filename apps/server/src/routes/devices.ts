// /api/devices: pair the desktop app, see when it was last seen, and unpair it. Owner only.
import { Hono } from "hono";
import { DEVICE_SCOPES, listDevices, pairDevice, unpairDevice } from "../auth/devices.ts";
import { requireCaller } from "../auth/middleware.ts";
import type { AppEnv } from "../env.ts";

export function deviceRoutes() {
  const app = new Hono<AppEnv>();
  app.use("*", requireCaller(["owner"]));

  app.get("/", async (c) => c.json({ devices: await listDevices(c.get("deps").kernel.db) }));

  // A new pairing code, shown once. Pairing again signs the old one out.
  app.post("/:name/pair", async (c) => {
    const name = c.req.param("name");
    if (!DEVICE_SCOPES[name]) return c.json({ error: "Nook doesn't know that device." }, 404);
    c.header("Cache-Control", "no-store");
    return c.json({ token: await pairDevice(c.get("deps").kernel.db, name) });
  });

  // Disconnecting the desktop app signs Hearth's window on the PC out too (D53).
  app.delete("/:name", async (c) =>
    c.json({ revoked: await unpairDevice(c.get("deps").kernel.db, c.req.param("name")) }),
  );
  return app;
}
