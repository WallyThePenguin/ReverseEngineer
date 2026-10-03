// Live docs: notes every screen edits at once, offline included, merged by Loro (PLAN.md section
// 8.5, D38). A screen syncs by sending what it changed and the version it has, and gets back
// what it's missing; changes made anywhere else show up through the live event feed.
import { entity } from "@hearth/db";
import { ActionError, defineAction, updateEntity } from "@hearth/kernel";
import { eq } from "drizzle-orm";
import { VersionVector } from "loro-crdt";
import { z } from "zod";
import { id } from "../shared.ts";
import { applyUpdate, DOC_TYPES, fold, openDoc, setRevision, textOf } from "./store.ts";

/** Base64, at most this many bytes once decoded. */
const b64 = (bytes: number) =>
  z
    .string()
    .max(Math.ceil(bytes / 3) * 4 + 4)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/);
const decode = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
const encode = (u: Uint8Array) => Buffer.from(u).toString("base64");

/** Live editing, part of the notes module (notes are the docs). */
export const docActions = [
  defineAction({
    name: "doc.sync",
    description:
      "A screen's sync: send what changed (a Loro update) and the version you have; get back what you're missing and the latest version.",
    input: z.object({
      id,
      version: b64(64 * 1024).optional(),
      update: b64(4 * 1024 * 1024).optional(),
    }),
    risk: "internal",
    // Screens sync; Jarvis edits through note.update, which merges the same way.
    callers: ["owner"],
    async handler(i, ctx) {
      const [row] = await ctx.tx.select().from(entity).where(eq(entity.id, i.id)).for("update");
      if (!row || row.deletedAt || !DOC_TYPES.has(row.type))
        throw new ActionError("not_found", "No such doc");
      const { doc, pending } = await openDoc(ctx, row);
      let from: VersionVector | undefined;
      try {
        from = i.version ? VersionVector.decode(decode(i.version)) : undefined;
      } catch {
        throw new ActionError("invalid_input", "That version isn't one Hearth can read.");
      }
      let added = 0;
      if (i.update) {
        try {
          if (await applyUpdate(ctx, row.id, doc, decode(i.update))) added = 1;
        } catch {
          throw new ActionError("invalid_input", "That update isn't one Hearth can read.");
        }
      }
      let revision = row.revision;
      const text = textOf(doc);
      if (text !== (row.body ?? "")) {
        revision = (await updateEntity(ctx, row.id, { body: text })).revision;
        await setRevision(ctx.tx, row.id, revision);
      }
      await fold(ctx, row.id, doc, pending + added);
      return {
        update: encode(doc.export(from ? { mode: "update", from } : { mode: "snapshot" })),
        version: encode(doc.oplogVersion().encode()),
        revision,
      };
    },
  }),
];
