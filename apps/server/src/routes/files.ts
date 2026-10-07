// /api/files: adding a file (only you, from the app: the bytes are the request's body and its
// name is ?name=), and reading one back. A PNG, JPEG, GIF or WebP is shown in Hearth's page; any
// other file, SVG and web pages included, is only ever downloaded, and nothing in one can run as
// part of Hearth (the same rules as mail's attachments, routes/mail.ts).
import {
  BLOB_SERVICE,
  type BlobStore,
  type FileView,
  fileMime,
  MAX_FILE_BYTES,
  SHOWN_IMAGES,
} from "@hearth/modules";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requireCaller } from "../auth/middleware.ts";
import type { AppEnv } from "../env.ts";

/** A file's name as a header value: plain where it can be, and exactly as UTF-8 beside that. */
const disposition = (how: "inline" | "attachment", name: string) => {
  const safe = name.replace(/[\r\n"\\]/g, "_");
  return `${how}; filename="${safe.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
};

export function fileRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", requireCaller());

  r.post(
    "/",
    requireCaller(["owner"]),
    bodyLimit({
      maxSize: MAX_FILE_BYTES,
      onError: (c) => c.json({ error: "That file is over 25 MB." }, 413),
    }),
    async (c) => {
      const { kernel } = c.get("deps");
      const bytes = Buffer.from(await c.req.arrayBuffer());
      if (bytes.length === 0) return c.json({ error: "That file is empty." }, 400);
      // A name, not a path: no folders, and no control characters to break a header with.
      const name = (c.req.query("name") ?? "").replace(/[\p{Cc}/\\]/gu, " ").trim();
      // Stored first: if keeping the record fails, the bytes are swept away later on their own.
      const hash = await (kernel.services[BLOB_SERVICE] as BlobStore).put(bytes);
      const res = await kernel.execute<FileView>(
        "file.create",
        {
          hash,
          name: name.slice(0, 200) || "File",
          mime: fileMime(bytes, c.req.header("content-type")),
          size: bytes.length,
        },
        c.get("caller")!,
      );
      if (res.status !== "ok")
        return c.json({ error: "message" in res ? res.message : "That file wasn't kept." }, 400);
      return c.json(res.result);
    },
  );

  // ?download=1 downloads an image too.
  r.get("/:id", async (c) => {
    const { kernel } = c.get("deps");
    const id = c.req.param("id");
    if (!/^[0-9a-f-]{36}$/i.test(id)) return c.text("Not found.", 404);
    // As the caller: one that may not read the record doesn't get its bytes either.
    const res = await kernel.execute<FileView & { hash: string }>(
      "file.get",
      { id },
      c.get("caller")!,
    );
    if (res.status !== "ok") return c.text("Not found.", 404);
    const f = res.result;
    // Asked about each time, so one trashed since is gone at once; the same bytes, still kept,
    // are answered without sending them again. That answer's headers replace the kept copy's,
    // so it carries the same policy: without one, Hearth's page policy would be put on it.
    const kept = {
      etag: `"${f.hash}"`,
      "cache-control": "private, no-cache",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
    };
    if (c.req.header("if-none-match") === kept.etag)
      return new Response(null, { status: 304, headers: kept });
    const bytes = await (kernel.services[BLOB_SERVICE] as BlobStore).get(f.hash);
    if (!bytes) return c.text("That file isn't on this PC.", 404);
    const shown = SHOWN_IMAGES.has(f.mime) && c.req.query("download") !== "1";
    return new Response(new Uint8Array(bytes), {
      headers: {
        ...kept,
        "content-type": shown ? f.mime : "application/octet-stream",
        "content-disposition": disposition(shown ? "inline" : "attachment", f.name),
      },
    });
  });

  return r;
}
