// /api/import/notion: upload a Notion export zip ("Markdown & CSV") and it becomes notes. Only you,
// from the app; the pages are written by the Notion import integration (outside content).
import { integrationCaller } from "@hearth/kernel";
import { ExportError, readExport, UPLOADS_SERVICE, type Uploads } from "@hearth/modules";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requireCaller } from "../auth/middleware.ts";
import type { AppEnv } from "../env.ts";

const MAX_BYTES = 200 * 1024 * 1024;

export function importRoutes() {
  const app = new Hono<AppEnv>();
  app.use("*", requireCaller(["owner"]));

  app.post(
    "/notion",
    bodyLimit({
      maxSize: MAX_BYTES,
      onError: (c) => c.json({ error: "That export is over 200 MB. Export fewer pages." }, 413),
    }),
    async (c) => {
      const { kernel } = c.get("deps");
      const name = (c.req.query("name") ?? "").replace(/\.zip$/i, "").slice(0, 200);
      let files: ReturnType<typeof readExport>;
      try {
        files = readExport(new Uint8Array(await c.req.arrayBuffer()));
      } catch (err) {
        if (err instanceof ExportError) return c.json({ error: err.message }, 400);
        throw err;
      }
      kernel.services[UPLOADS_SERVICE] ??= new Map();
      const uploads = kernel.services[UPLOADS_SERVICE] as Uploads;
      const upload = crypto.randomUUID();
      uploads.set(upload, files);
      try {
        const res = await kernel.execute(
          "notion.import",
          { upload, ...(name ? { name } : {}) },
          integrationCaller("notion"),
        );
        if (res.status !== "ok")
          return c.json({ error: "message" in res ? res.message : "The import failed." }, 400);
        return c.json(res.result);
      } finally {
        uploads.delete(upload);
      }
    },
  );
  return app;
}
