// Live docs: notes every screen edits at once, offline included, merged by Loro (PLAN.md section
// 8.5, D38). A screen syncs by sending what it changed and the version it has, and gets back
// what it's missing; changes made anywhere else show up through the live event feed.
import { docCheckpoint, entity } from "@hearth/db";
import { type ActionContext, ActionError, defineAction, newId, updateEntity } from "@hearth/kernel";
import { eq } from "drizzle-orm";
import { VersionVector } from "loro-crdt";
import { z } from "zod";
import { id } from "../shared.ts";
import { checkpointsOf, frontiersInput, peersOf, textAt, versions } from "./history.ts";
import {
  applyUpdate,
  DOC_TYPES,
  fold,
  loadDoc,
  openDoc,
  setRevision,
  textOf,
  writeDoc,
} from "./store.ts";

/** A live doc's record, or not_found. */
async function docRow(ctx: Pick<ActionContext, "tx">, docId: string) {
  const [row] = await ctx.tx.select().from(entity).where(eq(entity.id, docId));
  if (!row || row.deletedAt || !DOC_TYPES.has(row.type))
    throw new ActionError("not_found", "No such doc");
  return row;
}

/** The stored doc, and its text at a version (invalid_input if it has no such version). */
async function at(
  ctx: Pick<ActionContext, "tx">,
  docId: string,
  frontiers: { peer: string; counter: number }[],
) {
  const loaded = await loadDoc(ctx.tx, docId);
  const text = loaded ? textAt(loaded.doc, frontiers) : null;
  if (text === null) throw new ActionError("invalid_input", "This note has no such version.");
  return text;
}

const MAX_TEXT = 200_000;

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
      // The same ceiling as note.update: search, mentions and Jarvis read the whole body.
      if (text.length > MAX_TEXT)
        throw new ActionError("invalid_input", "That note is too long to save.");
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
  defineAction({
    name: "doc.history",
    description:
      "A doc's versions, newest first (one per stretch of editing, with who wrote them), and its named checkpoints.",
    input: z.object({ id }),
    risk: "read",
    callers: ["owner"],
    async handler(i, ctx) {
      await docRow(ctx, i.id);
      const loaded = await loadDoc(ctx.tx, i.id);
      return {
        versions: loaded ? versions(loaded.doc, await peersOf(ctx.tx, i.id)) : [],
        checkpoints: await checkpointsOf(ctx.tx, i.id),
      };
    },
  }),
  defineAction({
    name: "doc.version",
    description: "A doc's text as it was at a version from doc.history.",
    input: z.object({ id, frontiers: frontiersInput }),
    risk: "read",
    callers: ["owner"],
    async handler(i, ctx) {
      await docRow(ctx, i.id);
      return { text: await at(ctx, i.id, i.frontiers) };
    },
  }),
  defineAction({
    name: "doc.restore",
    description:
      "Put a doc back the way it was at a version. It's a new edit, so the history keeps everything since.",
    input: z.object({ id, frontiers: frontiersInput }),
    risk: "internal",
    callers: ["owner"],
    async handler(i, ctx) {
      await docRow(ctx, i.id);
      const text = await at(ctx, i.id, i.frontiers);
      if (text.length > MAX_TEXT)
        throw new ActionError("invalid_input", "That version is too long to put back.");
      const row = await writeDoc(ctx, i.id, { body: text }, { type: "note" });
      return { revision: row.revision };
    },
  }),
  defineAction({
    name: "doc.checkpoint",
    description: "Name a version of a doc (the current one unless given) so it's easy to find.",
    input: z.object({
      id,
      name: z.string().trim().min(1).max(100),
      frontiers: frontiersInput.optional(),
    }),
    risk: "internal",
    callers: ["owner"],
    async handler(i, ctx) {
      const row = await docRow(ctx, i.id);
      let frontiers = i.frontiers;
      if (frontiers) await at(ctx, i.id, frontiers);
      else {
        // Takes in anything written directly first, so the checkpoint has it.
        const [locked] = await ctx.tx
          .select()
          .from(entity)
          .where(eq(entity.id, row.id))
          .for("update");
        frontiers = (await openDoc(ctx, locked!)).doc.oplogFrontiers();
      }
      const made = {
        id: newId(),
        entityId: i.id,
        name: i.name,
        frontiers,
        createdBy: ctx.caller.principal,
      };
      await ctx.tx.insert(docCheckpoint).values(made);
      return { id: made.id };
    },
  }),
  defineAction({
    name: "doc.checkpoint_delete",
    description: "Remove a named checkpoint. The version itself stays in the history.",
    input: z.object({ id }),
    risk: "internal",
    callers: ["owner"],
    async handler(i, ctx) {
      const [cp] = await ctx.tx
        .select({ entityId: docCheckpoint.entityId })
        .from(docCheckpoint)
        .where(eq(docCheckpoint.id, i.id));
      if (!cp) throw new ActionError("not_found", "No such checkpoint");
      // Kept while its note is in the trash, so restoring the note brings it back.
      await docRow(ctx, cp.entityId);
      await ctx.tx.delete(docCheckpoint).where(eq(docCheckpoint.id, i.id));
      return { id: i.id };
    },
  }),
];
