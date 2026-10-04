// Drafts and sending. Anyone may write a draft (you, or Jarvis drafting a reply); sending one is
// `mail.send`, which is outward: Jarvis's sends wait for your yes, with the recipients and text on
// the card, and a draft changed after you were asked isn't sent.
import {
  type DbOrTx,
  entity,
  type MailAddress,
  mailAccount,
  mailDraft,
  mailMessage,
} from "@hearth/db";
import {
  type ActionContext,
  ActionError,
  createEntity,
  defineAction,
  type ReadContext,
  stableStringify,
  updateEntity,
} from "@hearth/kernel";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { body, id } from "../shared.ts";
import { buildMessage, cleanName } from "./mime.ts";
import { MailProviderError } from "./provider.ts";
import { saveMail } from "./store.ts";
import { providerFor } from "./sync.ts";
import { loadThread } from "./views.ts";

const address = z.string().trim().max(320).describe('An email address, or "Name <address>".');
const addresses = z.array(address).max(50);

/** "Ana Silva <ana@x.example>" or "ana@x.example" → an address, or null if it isn't one. */
export function parseAddress(raw: string): MailAddress | null {
  const m =
    raw.trim().match(/^(?:"?([^"<]*?)"?\s*)?<([^<>\s]+@[^<>\s]+)>$/) ??
    raw.trim().match(/^()([^<>\s]+@[^<>\s]+)$/);
  if (!m || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(m[2]!)) return null;
  return clean({ address: m[2]!, name: m[1] });
}

/** An address as a draft keeps it: lower-case, with a name that's safe to show. */
function clean(a: MailAddress): MailAddress {
  const name = cleanName(a.name);
  return { address: a.address.toLowerCase(), ...(name ? { name } : {}) };
}

/** Address first, so a name can't pass for another recipient: "ana@x.example (Ana Silva)". */
const shown = (a: MailAddress) => (a.name ? `${a.address} (${a.name})` : a.address);
/** Subjects on one line, without characters that change how the line reads. */
const oneLine = (s: string) => s.replace(/[\p{Cc}\p{Cf}]/gu, " ");

function parseAll(list: string[] | undefined): MailAddress[] | undefined {
  if (!list) return undefined;
  return list.map((raw) => {
    const a = parseAddress(raw);
    if (!a) throw new ActionError("invalid_input", `"${raw}" isn't an email address.`);
    return a;
  });
}

export interface DraftView {
  id: string;
  account: string;
  threadId: string | null;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  text: string;
  updatedAt: Date;
}

export async function loadDraft(db: DbOrTx, draftId: string): Promise<DraftView | null> {
  const [row] = await db
    .select({ d: mailDraft, e: entity, account: mailAccount.address })
    .from(mailDraft)
    .innerJoin(entity, eq(entity.id, mailDraft.entityId))
    .innerJoin(mailAccount, eq(mailAccount.id, mailDraft.accountId))
    .where(and(eq(mailDraft.entityId, draftId), isNull(entity.deletedAt)));
  if (!row) return null;
  return {
    id: row.e.id,
    account: row.account,
    threadId: row.d.threadId,
    to: row.d.toAddresses,
    cc: row.d.ccAddresses,
    bcc: row.d.bccAddresses,
    subject: row.e.title,
    text: row.e.body ?? "",
    updatedAt: row.e.updatedAt,
  };
}

/** What sending a draft would send, as the approval card shows it. */
export function snapshotOf(d: DraftView) {
  return {
    from: d.account,
    to: d.to.map(shown),
    cc: d.cc.map(shown),
    bcc: d.bcc.map(shown),
    subject: d.subject,
    text: d.text,
  };
}
type Snapshot = ReturnType<typeof snapshotOf>;

const snapshotSchema = z
  .object({
    from: z.string(),
    to: z.array(z.string()),
    cc: z.array(z.string()),
    bcc: z.array(z.string()),
    subject: z.string(),
    text: z.string(),
  })
  .describe("Filled in by Hearth: what will be sent. Leave it out.");

/** The account a new message goes from: the one named, or your only (or first) one. */
async function accountFor(ctx: ActionContext, wanted?: string) {
  const rows = await ctx.tx.select().from(mailAccount).orderBy(asc(mailAccount.address));
  const row = wanted ? rows.find((r) => r.address === wanted.toLowerCase()) : rows[0];
  if (!row)
    throw new ActionError(
      wanted ? "not_found" : "unavailable",
      wanted
        ? `No mail account ${wanted} is connected.`
        : "No mail account is connected. Connect Gmail in Settings.",
    );
  return row;
}

/** Who a reply goes to, and the headers that keep it in the conversation. */
async function replyHeaders(ctx: ActionContext, threadId: string, all: boolean) {
  const t = await loadThread(ctx.tx, threadId);
  if (!t) throw new ActionError("not_found", "No email conversation with that id.");
  const rows = await ctx.tx
    .select()
    .from(mailMessage)
    .where(eq(mailMessage.threadId, threadId))
    .orderBy(desc(mailMessage.sentAt));
  const last = rows.find((m) => !m.outbound) ?? rows[0];
  if (!last) throw new ActionError("not_found", "That conversation has no messages.");
  const [account] = await ctx.tx
    .select()
    .from(mailAccount)
    .where(eq(mailAccount.id, last.accountId));
  const self = account!.address;
  const from: MailAddress = {
    address: last.fromAddress,
    ...(last.fromName ? { name: last.fromName } : {}),
  };
  const to = (
    last.outbound ? last.toAddresses : [last.replyTo ? { address: last.replyTo } : from]
  ).map(clean);
  const taken = new Set([self, ...to.map((a) => a.address)]);
  const cc = all
    ? [...last.toAddresses, ...last.ccAddresses].map(clean).filter((a) => {
        if (taken.has(a.address)) return false;
        taken.add(a.address);
        return true;
      })
    : [];
  return {
    account,
    to,
    cc,
    subject: /^re:/i.test(t.subject) ? t.subject : `Re: ${t.subject}`,
    inReplyTo: last.messageId,
    refs: [...last.refs, last.messageId].slice(-20),
  };
}

export const draftActions = [
  defineAction({
    name: "mail.draft",
    description:
      "Write an email draft. To reply, give threadId (recipients, subject and threading come from the conversation; replyAll adds everyone on it). Nothing is sent: the owner sends it, or you ask with mail_send.",
    input: z.object({
      threadId: id.optional(),
      replyAll: z.boolean().default(false),
      to: addresses.optional(),
      cc: addresses.optional(),
      bcc: addresses.optional(),
      subject: z.string().max(500).optional(),
      text: body,
      account: z.string().email().optional().describe("Which of the owner's accounts it's from."),
    }),
    risk: "internal",
    async handler(i, ctx) {
      const reply = i.threadId ? await replyHeaders(ctx, i.threadId, i.replyAll) : null;
      const account = reply?.account ?? (await accountFor(ctx, i.account));
      const subject = i.subject ?? reply?.subject ?? "";
      const draft = await createEntity(ctx, { type: "email_draft", title: subject, body: i.text });
      await ctx.tx.insert(mailDraft).values({
        entityId: draft.id,
        accountId: account.id,
        threadId: i.threadId ?? null,
        toAddresses: parseAll(i.to) ?? reply?.to ?? [],
        ccAddresses: parseAll(i.cc) ?? reply?.cc ?? [],
        bccAddresses: parseAll(i.bcc) ?? [],
        inReplyTo: reply?.inReplyTo ?? null,
        refs: reply?.refs ?? [],
      });
      return loadDraft(ctx.tx, draft.id);
    },
  }),
  defineAction({
    name: "mail.draft_update",
    description: "Change a draft: recipients, subject or text. Leave out what stays the same.",
    input: z.object({
      id,
      to: addresses.optional(),
      cc: addresses.optional(),
      bcc: addresses.optional(),
      subject: z.string().max(500).optional(),
      text: body.optional(),
    }),
    risk: "internal",
    async handler(i, ctx) {
      if (!(await loadDraft(ctx.tx, i.id)))
        throw new ActionError("not_found", "No draft with that id.");
      await updateEntity(ctx, i.id, { title: i.subject, body: i.text }, { type: "email_draft" });
      const to = parseAll(i.to);
      const cc = parseAll(i.cc);
      const bcc = parseAll(i.bcc);
      if (to || cc || bcc)
        await ctx.tx
          .update(mailDraft)
          .set({
            ...(to ? { toAddresses: to } : {}),
            ...(cc ? { ccAddresses: cc } : {}),
            ...(bcc ? { bccAddresses: bcc } : {}),
          })
          .where(eq(mailDraft.entityId, i.id));
      const d = (await loadDraft(ctx.tx, i.id))!;
      // What's in the draft now, for a Send that must match it.
      return { ...d, snapshot: snapshotOf(d) };
    },
  }),
  defineAction({
    name: "mail.drafts",
    description: "Drafts waiting to be sent, newest first, or the ones for one conversation.",
    input: z.object({ threadId: id.optional() }),
    risk: "read",
    // Replies carry the sender's subject and names, and may hold text written after reading mail.
    external: true,
    async handler(i, ctx) {
      const rows = await ctx.tx
        .select({ id: mailDraft.entityId })
        .from(mailDraft)
        .innerJoin(entity, eq(entity.id, mailDraft.entityId))
        .where(
          and(
            isNull(entity.deletedAt),
            i.threadId ? eq(mailDraft.threadId, i.threadId) : undefined,
          ),
        )
        .orderBy(desc(entity.updatedAt))
        .limit(100);
      const out = await Promise.all(rows.map((r) => loadDraft(ctx.tx, r.id)));
      return out.filter((d) => d !== null);
    },
  }),
  defineAction({
    name: "mail.discard",
    description: "Throw a draft away.",
    input: z.object({ id }),
    risk: "internal",
    async handler(i, ctx) {
      if (!(await loadDraft(ctx.tx, i.id)))
        throw new ActionError("not_found", "No draft with that id.");
      await ctx.tx.delete(entity).where(eq(entity.id, i.id));
      return { discarded: true };
    },
  }),
  defineAction({
    name: "mail.send",
    description:
      "Send a draft by its id. Get it right first: the owner sees exactly what goes out.",
    input: z.object({ id, snapshot: snapshotSchema.optional() }),
    risk: "outward",
    async snapshot(i: { id: string }, ctx: ReadContext) {
      const d = await loadDraft(ctx.db, i.id);
      if (!d) throw new Error("No draft with that id.");
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
      const [draftRow] = await ctx.tx.select().from(mailDraft).where(eq(mailDraft.entityId, d.id));
      const [account] = await ctx.tx
        .select()
        .from(mailAccount)
        .where(eq(mailAccount.id, draftRow!.accountId));
      const raw = buildMessage({
        from: { address: account!.address },
        to: d.to,
        cc: d.cc,
        bcc: d.bcc,
        subject: d.subject,
        text: d.text,
        inReplyTo: draftRow!.inReplyTo,
        references: draftRow!.refs,
        date: ctx.now,
      });
      const sent = await providerFor(ctx, account!)
        .send(account!.address, raw)
        .catch((err: unknown) => {
          throw sendError(err, account!.address);
        });
      // Kept here at once, so it shows in the conversation before the next sync. It has gone
      // out either way, so failing to keep it mustn't undo the send (the next sync brings it in).
      const saved = await ctx.tx
        .transaction((tx) =>
          saveMail({ ...ctx, tx }, account!, {
            providerId: sent.providerId,
            labels: ["SENT"],
            raw,
          }),
        )
        .catch(() => null);
      await ctx.tx.delete(entity).where(eq(entity.id, d.id));
      ctx.emit({
        kind: "mail.sent",
        entityId: saved?.threadId ?? null,
        payload: { to: now.to, subject: d.subject },
      });
      return { sent: true, threadId: saved?.threadId ?? null, messageId: saved?.id ?? null };
    },
  }),
];

/** Why a send didn't go, in words for the owner. The draft stays either way. */
function sendError(err: unknown, from: string): unknown {
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
      "Gmail didn't answer, so Hearth can't tell whether it went out. Check Sent in Gmail before sending it again.",
    );
  return err;
}

/** A draft as markdown, for Jarvis. */
export async function describeDraft(entityId: string, ctx: ReadContext): Promise<string | null> {
  const d = await loadDraft(ctx.db, entityId);
  if (!d) return null;
  const s = snapshotOf(d);
  return [
    `# ${d.subject || "(no subject)"}`,
    `id: ${d.id} · email draft from ${d.account}${d.threadId ? ` · a reply in conversation ${d.threadId}` : ""}`,
    `To: ${s.to.join(", ") || "(nobody yet)"}${s.cc.length ? ` · Cc: ${s.cc.join(", ")}` : ""}${s.bcc.length ? ` · Bcc: ${s.bcc.join(", ")}` : ""}`,
    "",
    d.text,
  ].join("\n");
}
