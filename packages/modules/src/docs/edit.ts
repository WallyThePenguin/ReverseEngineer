// Jarvis as a co-editor (PLAN.md section 8.5): small edits made in place through the doc, so they
// merge with whatever you're typing at the same moment and show up live on your screen.
import { entity } from "@hearth/db";
import { ActionError, defineAction, updateEntity } from "@hearth/kernel";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { id } from "../shared.ts";
import { DOC_TYPES, editAsCaller, finish, openDoc, textOf } from "./store.ts";

const passage = z.string().min(1).max(5_000);
const addition = z.string().max(20_000);
const edit = z.union([
  z.object({ find: passage, replace: addition }).strict(),
  z.object({ after: passage, insert: addition.min(1) }).strict(),
  z.object({ append: addition.min(1) }).strict(),
]);
export type DocEdit = z.infer<typeof edit>;

/** Where a passage is in the text: it has to be there exactly once. */
function locate(text: string, find: string): number {
  const at = text.indexOf(find);
  if (at < 0)
    throw new ActionError("invalid_input", `Couldn't find "${find.slice(0, 80)}" in the note.`);
  if (text.indexOf(find, at + 1) >= 0)
    throw new ActionError(
      "invalid_input",
      `"${find.slice(0, 80)}" is in the note more than once; include more of the text around it.`,
    );
  return at;
}

export const docEdit = defineAction({
  name: "doc.edit",
  description:
    "Edit part of a note in place: replace exact text, insert after exact text, or append. Edits apply in order and merge with anyone typing in it at the same time. Prefer this to note_update for changes to part of a note. Pass revision to fail if the note changed since you read it.",
  input: z.object({
    id,
    edits: z.array(edit).min(1).max(20),
    revision: z.number().int().optional(),
  }),
  risk: "internal",
  callers: ["owner", "agent", "mcp_client"],
  async handler(i, ctx) {
    const [row] = await ctx.tx.select().from(entity).where(eq(entity.id, i.id)).for("update");
    if (!row || row.deletedAt || row.type !== "note")
      throw new ActionError("not_found", "No such note");
    if (i.revision !== undefined && i.revision !== row.revision)
      throw new ActionError("conflict", "The note changed since you read it. Read it again.");
    const { doc, pending } = await openDoc(ctx, row);
    const added = await editAsCaller(ctx, row.id, doc, (t) => {
      for (const e of i.edits) {
        const now = t.toString();
        if ("find" in e) {
          const at = locate(now, e.find);
          t.splice(at, e.find.length, e.replace);
        } else if ("after" in e) {
          t.insert(locate(now, e.after) + e.after.length, e.insert);
        } else {
          t.insert(now.length, now && !now.endsWith("\n") ? `\n${e.append}` : e.append);
        }
      }
    });
    const text = textOf(doc);
    if (text.length > DOC_TYPES.get("note")!.maxChars)
      throw new ActionError("invalid_input", "That would make the note too long.");
    if (!added) return { id: row.id, revision: row.revision, changed: false };
    const out = await updateEntity(ctx, row.id, { body: text });
    await finish(ctx, row.id, out.revision, doc, pending + 1);
    return { id: row.id, revision: out.revision, changed: true };
  },
});
