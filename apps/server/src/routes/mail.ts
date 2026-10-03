// An email's HTML in a frame of its own, and downloading attachments, both from the original
// message kept on this PC. The frame's policy lets nothing run and nothing load from the internet
// (so senders can't tell you opened it) until you ask for images. Attachments are always
// downloads, never shown in Hearth's own page, so one can't run as part of Hearth.
import { BLOB_SERVICE, type BlobStore, messageAttachment, messageHtml } from "@hearth/modules";
import { Hono } from "hono";
import type { AppEnv } from "../env.ts";

export function mailRoutes() {
  const r = new Hono<AppEnv>();

  r.get("/frame/:id", async (c) => {
    if (c.get("caller")?.kind !== "owner") return c.text("Sign in to Hearth first.", 401);
    const { kernel } = c.get("deps");
    const id = c.req.param("id");
    if (!/^[0-9a-f-]{36}$/i.test(id)) return c.text("Not found.", 404);
    const shown = await messageHtml(kernel.db, kernel.services[BLOB_SERVICE] as BlobStore, id);
    if (!shown) return c.text("This message's original isn't on this PC.", 404);
    const images = c.req.query("images") === "1";
    const remote = images ? " https: http:" : "";
    const policy = [
      "default-src 'none'",
      `img-src data:${remote}`,
      `style-src 'unsafe-inline'${remote}`,
      `font-src data:${remote}`,
      "frame-ancestors 'self'",
      "form-action 'none'",
    ].join("; ");
    const page = `<!doctype html><html><head><meta charset="utf-8">
<meta name="hearth-remote-images" content="${shown.remoteImages ? "1" : "0"}">
<base target="_blank"><style>html{color-scheme:light}body{margin:0;padding:12px;font:14px/1.5 system-ui,sans-serif;color:#222;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style>
</head><body>${shown.html}</body></html>`;
    return new Response(page, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": policy,
        "referrer-policy": "no-referrer",
        "cache-control": "private, no-store",
      },
    });
  });

  r.get("/attachment/:id/:index", async (c) => {
    if (c.get("caller")?.kind !== "owner") return c.text("Sign in to Hearth first.", 401);
    const { kernel } = c.get("deps");
    const id = c.req.param("id");
    const index = Number(c.req.param("index"));
    if (!/^[0-9a-f-]{36}$/i.test(id) || !Number.isInteger(index) || index < 0)
      return c.text("Not found.", 404);
    const blobs = kernel.services[BLOB_SERVICE] as BlobStore;
    const file = await messageAttachment(kernel.db, blobs, id, index);
    if (!file) return c.text("That attachment isn't on this PC.", 404);
    const name = file.filename.replace(/[\r\n"\\]/g, "_");
    return new Response(new Uint8Array(file.content), {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox",
      },
    });
  });

  return r;
}
