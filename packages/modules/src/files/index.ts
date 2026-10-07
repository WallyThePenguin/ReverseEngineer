// Files you add to Hearth: an image pasted into a note, a PDF dropped on a task, a screenshot in
// chat. Each is a record of type "file", named for the file, so it's found, linked, trashed and
// restored like any other; its bytes are kept once, by their SHA-256, in the same store as mail's
// originals (mail/blobs.ts), which the nightly backup takes off-site. Trashing one keeps its
// bytes, so it can come back; mail's sweep leaves alone the bytes any file has (mail/repair.ts).
// Only you add files, from the app (the server's /api/files route); what's in them is never run.
import { entity, storedFile } from "@hearth/db";
import { ActionError, createEntity, defineAction, defineModule } from "@hearth/kernel";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { BLOB_SERVICE, type BlobStore } from "../mail/blobs.ts";
import { describeRow, id, liveEntity } from "../shared.ts";

/** The largest file Hearth takes. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Images Hearth shows in its own page. Anything else, SVG included, is only ever downloaded. */
export const SHOWN_IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * What a file is: from its first bytes where it's an image Hearth shows, so a page saved as
 * "cat.png" is never drawn as one; otherwise what the browser said, if that's a plain type.
 */
export function fileMime(bytes: Uint8Array, said: string | undefined): string {
  const starts = (sig: number[], at = 0) => sig.every((b, i) => bytes[at + i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  const type = (said ?? "").split(";")[0]!.trim().toLowerCase();
  return /^[a-z]+\/[a-z0-9.+-]{1,100}$/.test(type) && !SHOWN_IMAGES.has(type)
    ? type
    : "application/octet-stream";
}

export interface FileView {
  id: string;
  name: string;
  mime: string;
  size: number;
}

export const filesModule = defineModule({
  name: "files",
  description: "Files you add to Hearth: images and documents pasted, dropped or uploaded.",
  entityTypes: ["file"],
  events: [],
  reflexes: [],
  noReflexesBecause: "A file is kept, not acted on; the note, task or chat it's in carries it.",
  knowledge: {
    async file(entityId, ctx) {
      const row = await liveEntity(ctx.db, entityId, "file");
      if (!row) return null;
      const [f] = await ctx.db.select().from(storedFile).where(eq(storedFile.entityId, entityId));
      return describeRow(row, [f ? `a file: ${f.mime}, ${f.size} bytes` : "a file"]);
    },
  },
  actions: [
    defineAction({
      name: "file.create",
      description:
        "Keep a file the server has just stored as a record. Only the app calls this, for a file you added.",
      input: z.object({
        hash: z.string().regex(/^[0-9a-f]{64}$/),
        name: z.string().trim().min(1).max(200),
        mime: z.string().min(3).max(120),
        size: z.number().int().min(1).max(MAX_FILE_BYTES),
      }),
      risk: "internal",
      // Bytes are named by hash: anyone else could name ones that aren't a file (an email's).
      callers: ["owner"],
      async handler(i, ctx): Promise<FileView> {
        if (!(await ctx.service<BlobStore>(BLOB_SERVICE).has(i.hash)))
          throw new ActionError("not_found", "That file isn't stored on this PC.");
        const row = await createEntity(ctx, { type: "file", title: i.name, body: "" });
        await ctx.tx
          .insert(storedFile)
          .values({ entityId: row.id, hash: i.hash, mime: i.mime, size: i.size });
        return { id: row.id, name: row.title, mime: i.mime, size: i.size };
      },
    }),
    defineAction({
      name: "file.get",
      description: "A file's name, type (like image/png) and size in bytes.",
      input: z.object({ id }),
      risk: "read",
      async handler(i, ctx): Promise<FileView & { hash: string }> {
        const [f] = await ctx.tx
          .select({
            name: entity.title,
            hash: storedFile.hash,
            mime: storedFile.mime,
            size: storedFile.size,
          })
          .from(storedFile)
          .innerJoin(entity, eq(entity.id, storedFile.entityId))
          .where(and(eq(storedFile.entityId, i.id), isNull(entity.deletedAt)));
        if (!f) throw new ActionError("not_found", "No such file");
        return { id: i.id, ...f };
      },
    }),
  ],
});
