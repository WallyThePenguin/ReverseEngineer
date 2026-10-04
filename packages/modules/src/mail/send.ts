// Sending a draft. It's outward: Jarvis's sends wait for your yes, with the recipients and text
// on the card, and a draft changed after you were asked isn't sent. A send goes out once: the
// draft's Message-ID was chosen when it was written, and Sent is checked for it first, so a send
// that went out while Hearth didn't hear back (Gmail didn't answer, or Hearth stopped mid-way)
// isn't sent again when you press Send a second time (D61).
import { entity, mailAccount, mailDraft } from "@hearth/db";
import { ActionError, defineAction, type ReadContext, stableStringify } from "@hearth/kernel";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { id } from "../shared.ts";
import { loadDraft, oneLine, type Snapshot, snapshotOf, snapshotSchema } from "./drafts.ts";
import { buildMessage } from "./mime.ts";
import { MailProviderError, type RawMail } from "./provider.ts";
import { providerFor } from "./providers.ts";
import { saveMail } from "./store.ts";

/** A draft kept from an account you disconnected goes nowhere until you choose a From. */
const NO_ACCOUNT = "Pick which account this draft goes from first.";

export const sendAction = defineAction({
  name: "mail.send",
  description: "Send a draft by its id. Get it right first: the owner sees exactly what goes out.",
  input: z.object({ id, snapshot: snapshotSchema.optional() }),
  risk: "outward",
  async snapshot(i: { id: string }, ctx: ReadContext) {
    const d = await loadDraft(ctx.db, i.id);
    if (!d) throw new Error("No draft with that id.");
    if (!d.account) throw new Error(NO_ACCOUNT);
    return { snapshot: snapshotOf(d) };
  },
  summarize: (i: { id: string; snapshot?: Snapshot }) => {
    const s = i.snapshot;
    if (!s) return `Send draft ${i.id}`;
    const cc = s.cc.length ? `, cc ${s.cc.join(", ")}` : "";
    const bcc = s.bcc.length ? `, bcc ${s.bcc.join(", ")}` : "";
    // All of it: the card shows exactly what goes out.
    return `Send email from ${s.from} to ${s.to.join(", ")}${cc}${bcc}: "${oneLine(s.subject)}"\n\n${s.text}`;
  },
  async handler(i, ctx) {
    // Held until this send finishes, so two Sends can't both go out.
    await ctx.tx.select().from(mailDraft).where(eq(mailDraft.entityId, i.id)).for("update");
    const d = await loadDraft(ctx.tx, i.id);
    if (!d)
      throw new ActionError("not_found", "No draft with that id. Was it sent or thrown away?");
    const now = snapshotOf(d);
    if (i.snapshot && stableStringify(i.snapshot) !== stableStringify(now))
      throw new ActionError(
        "conflict",
        "The draft changed since you were asked, so nothing was sent.",
      );
    if (!i.snapshot && ctx.caller.kind !== "owner")
      throw new ActionError(
        "conflict",
        "Hearth couldn't show the owner what this would send, so nothing was sent.",
      );
    if (d.to.length + d.cc.length + d.bcc.length === 0)
      throw new ActionError("invalid_input", "The draft has no recipients.");
    const [row] = await ctx.tx
      .select({ draft: mailDraft, written: entity.createdAt })
      .from(mailDraft)
      .innerJoin(entity, eq(entity.id, mailDraft.entityId))
      .where(eq(mailDraft.entityId, d.id));
    const draftRow = row?.draft;
    if (!row || !draftRow?.accountId) throw new ActionError("invalid_input", NO_ACCOUNT);
    const [account] = await ctx.tx
      .select()
      .from(mailAccount)
      .where(eq(mailAccount.id, draftRow.accountId));
    const from = account!.address;
    const provider = providerFor(ctx, account!);
    const messageId = draftRow.messageId;
    // Already in Sent: an earlier Send went out without Hearth hearing back. Keep that one. It
    // can't have gone before the draft was written; a change made since doesn't hide it.
    const earlier = await provider.findSent(from, messageId, row.written).catch((err: unknown) => {
      throw sendError(err, from, false);
    });
    let sent: RawMail | null;
    if (earlier) sent = await provider.fetch(from, earlier).catch(() => null);
    else {
      const raw = buildMessage({
        from: { address: from },
        to: d.to,
        cc: d.cc,
        bcc: d.bcc,
        subject: d.subject,
        text: d.text,
        messageId,
        hearthId: messageId,
        inReplyTo: draftRow.inReplyTo,
        references: draftRow.refs,
        date: ctx.now,
      });
      const { providerId } = await provider.send(from, raw).catch((err: unknown) => {
        throw sendError(err, from, true);
      });
      sent = { providerId, labels: ["SENT"], raw };
    }
    // Kept here at once, so it shows in the conversation before the next sync. It has gone
    // out either way, so failing to keep it mustn't undo the send (the next sync brings it in).
    const saved = sent
      ? await ctx.tx.transaction((tx) => saveMail({ ...ctx, tx }, account!, sent)).catch(() => null)
      : null;
    await ctx.tx.delete(entity).where(eq(entity.id, d.id));
    ctx.emit({
      kind: "mail.sent",
      entityId: saved?.threadId ?? null,
      payload: { to: now.to, subject: d.subject, ...(earlier ? { alreadySent: true } : {}) },
    });
    return {
      sent: true,
      ...(earlier ? { alreadySent: true } : {}),
      threadId: saved?.threadId ?? null,
      messageId: saved?.id ?? null,
    };
  },
});

/**
 * Why a send didn't go, in words for the owner. The draft stays either way. `sending`: the
 * message itself was on its way, so it may have gone out.
 */
function sendError(err: unknown, from: string, sending: boolean): unknown {
  if (!(err instanceof MailProviderError)) return err;
  if (err.slowDown) {
    const seconds = Math.max(5, Math.ceil((err.retryAfterMs ?? 60_000) / 1000));
    const when =
      seconds < 90 ? `in about ${seconds} seconds` : `in ${Math.ceil(seconds / 60)} minutes`;
    // "paced": Hearth held it back itself, to keep Gmail from turning it away.
    const why =
      err.kind === "paced"
        ? "Hearth is spacing out its Gmail calls"
        : "Gmail asked Hearth to slow down";
    return new ActionError("unavailable", `${why}, so nothing was sent. Try again ${when}.`);
  }
  if (err.kind === "auth")
    return new ActionError(
      "unavailable",
      `Google stopped accepting Hearth's access to ${from}, so nothing was sent. Connect it again in Settings.`,
    );
  if (err.kind === "transient")
    return new ActionError(
      "unavailable",
      sending
        ? "Gmail didn't answer, so Hearth can't tell yet whether it went out. Press Send again in a minute: Hearth looks in Sent first, so it won't go twice."
        : "Gmail didn't answer, so nothing was sent. Try again in a minute.",
    );
  return err;
}
