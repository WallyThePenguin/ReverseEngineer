// Archiving, and putting back: mail.archive answers with exactly the messages it took out of the
// inbox, so its Undo puts back just those (mail.unarchive with messages), never a reply you sent
// or a message trashed since. mail.unarchive without them is "back to the inbox" for whole
// conversations, out of the trash too.

import { mailMessage } from "@hearth/db";
import { defineAction } from "@hearth/kernel";
import { inArray } from "drizzle-orm";
import { z } from "zod";
import { id } from "../shared.ts";
import { changeFlags } from "./flags.ts";

const ids = z.array(id).min(1).max(500).describe("Conversation ids.");
const conversations = (n: number) => `${n} conversation${n === 1 ? "" : "s"}`;

export const archiveAction = defineAction({
  name: "mail.archive",
  description:
    "Archive conversations: out of the inbox, kept in All mail. Answers with the messages it took out of the inbox (inbox), for mail.unarchive to put back exactly.",
  input: z.object({ ids }),
  risk: "internal",
  summarize: (i: { ids: string[] }) => `Archive conversations (${conversations(i.ids.length)})`,
  async handler(i, ctx) {
    const msgs = await ctx.tx
      .select({ id: mailMessage.entityId, labels: mailMessage.labels })
      .from(mailMessage)
      .where(inArray(mailMessage.threadId, i.ids));
    const inbox = msgs.filter((m) => m.labels.includes("INBOX")).map((m) => m.id);
    return { changed: await changeFlags(ctx, i.ids, [], ["INBOX"]), inbox };
  },
});

export const unarchiveAction = defineAction({
  name: "mail.unarchive",
  description:
    "Move conversations back to the inbox, out of the trash too. To undo mail.archive, give the messages it answered with: just those go back, and nothing else changes.",
  input: z.object({
    ids,
    messages: z.array(id).max(5000).optional().describe("From mail.archive's answer (inbox)."),
  }),
  risk: "internal",
  summarize: (i: { ids: string[] }) =>
    `Move conversations back to the inbox (${conversations(i.ids.length)})`,
  async handler(i, ctx) {
    if (!i.messages) return { changed: await changeFlags(ctx, i.ids, ["INBOX"], ["TRASH"]) };
    // Undoing an archive: a message trashed since stays in the trash.
    const msgs = await ctx.tx
      .select({ id: mailMessage.entityId, labels: mailMessage.labels })
      .from(mailMessage)
      .where(inArray(mailMessage.entityId, i.messages));
    const back = msgs.filter((m) => !m.labels.includes("TRASH")).map((m) => m.id);
    return { changed: await changeFlags(ctx, i.ids, ["INBOX"], [], back) };
  },
});
