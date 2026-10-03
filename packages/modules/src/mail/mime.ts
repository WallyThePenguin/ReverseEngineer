// Reading and writing raw email (RFC 5322 and MIME). Parsing is postal-mime's; writing is the small
// subset Hearth sends: plain text, optionally with an HTML version, and attachments.
import { randomBytes } from "node:crypto";
import type { MailAddress, MailAttachment } from "@hearth/db";
import PostalMime, { type Address } from "postal-mime";

export interface ParsedMail {
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  subject: string;
  from: MailAddress | null;
  to: MailAddress[];
  cc: MailAddress[];
  replyTo: string | null;
  date: Date | null;
  text: string;
  html: string | null;
  attachments: (MailAttachment & { content: Buffer })[];
}

/** "<abc@x>" or "abc@x" → "abc@x". */
export function bareId(id: string): string {
  return id.trim().replace(/^<|>$/g, "").trim();
}

/** Every <message-id> in a References or In-Reply-To header, in order. */
export function idList(header: string | undefined | null): string[] {
  if (!header) return [];
  const ids = header.match(/<[^<>\s]+>/g);
  return (ids ?? header.split(/\s+/)).map(bareId).filter(Boolean);
}

function flatten(list: Address[] | Address | undefined): MailAddress[] {
  const all = list === undefined ? [] : Array.isArray(list) ? list : [list];
  const out: MailAddress[] = [];
  for (const a of all) {
    for (const m of a.group ?? [a]) {
      if (!m.address) continue;
      out.push({ address: m.address.toLowerCase(), ...(m.name ? { name: m.name } : {}) });
    }
  }
  return out;
}

const toBuffer = (c: ArrayBuffer | Uint8Array | string): Buffer =>
  typeof c === "string" ? Buffer.from(c, "base64") : Buffer.from(c as ArrayBuffer);

export async function parseMail(raw: Buffer): Promise<ParsedMail> {
  const m = await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" });
  const date = m.date ? new Date(m.date) : null;
  const html = m.html?.trim() ? m.html : null;
  return {
    messageId: m.messageId ? bareId(m.messageId) : null,
    inReplyTo: idList(m.inReplyTo)[0] ?? null,
    references: idList(m.references),
    subject: (m.subject ?? "").replace(/\s+/g, " ").trim(),
    from: flatten(m.from)[0] ?? null,
    to: flatten(m.to),
    cc: flatten(m.cc),
    replyTo: flatten(m.replyTo)[0]?.address ?? null,
    date: date && !Number.isNaN(date.getTime()) ? date : null,
    text: (m.text ?? "").trim() || (html ? htmlToText(html) : ""),
    html,
    attachments: m.attachments.map((a, index) => {
      const content = toBuffer(a.content);
      return {
        index,
        filename: a.filename ?? `attachment-${index + 1}`,
        mimeType: a.mimeType || "application/octet-stream",
        size: content.length,
        ...(a.contentId ? { contentId: bareId(a.contentId) } : {}),
        ...(a.disposition === "inline" || a.related ? { inline: true } : {}),
        content,
      };
    }),
  };
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** A readable plain-text version of an HTML email, for search, previews and Jarvis. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head|title)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, e: string) => {
      if (e[0] === "#") {
        const code =
          e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
        return Number.isFinite(code) && code > 0 && code < 0x110000
          ? String.fromCodePoint(code)
          : all;
      }
      return ENTITIES[e.toLowerCase()] ?? all;
    })
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The first line or so of a message, without quoted replies. */
export function snippetOf(text: string, max = 200): string {
  const own = text
    .split("\n")
    .filter((l) => !l.startsWith(">"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return own.length > max ? `${own.slice(0, max - 1)}…` : own;
}

// --- Writing ---

/** A header value, RFC 2047-encoded when it isn't plain ASCII. */
function headerText(s: string): string {
  const clean = s.replace(/[\r\n]+/g, " ");
  return /^[\x20-\x7e]*$/.test(clean)
    ? clean
    : `=?UTF-8?B?${Buffer.from(clean).toString("base64")}?=`;
}

/** A display name made safe to show and send: no control or direction-changing characters. */
export function cleanName(name: string | undefined): string | undefined {
  const clean = name
    ?.replace(/[\p{Cc}\p{Cf}"<>\\]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  return clean || undefined;
}

/** "Name" <address>, with the name always quoted (or encoded), so it can't add recipients. */
export function formatAddress(a: MailAddress): string {
  const name = cleanName(a.name);
  if (!name) return a.address;
  return `${/^[\x20-\x7e]*$/.test(name) ? `"${name}"` : headerText(name)} <${a.address}>`;
}

const base64Lines = (data: Buffer) => data.toString("base64").replace(/.{76}(?=.)/g, "$&\r\n");

export interface OutgoingMail {
  from: MailAddress;
  to: MailAddress[];
  cc?: MailAddress[];
  bcc?: MailAddress[];
  subject: string;
  text: string;
  html?: string;
  messageId?: string;
  inReplyTo?: string | null;
  references?: string[];
  date?: Date;
  attachments?: { filename: string; mimeType: string; content: Buffer }[];
}

/** A new Message-ID on the sender's domain. */
export function newMessageId(from: string): string {
  const domain = from.split("@")[1] || "hearth.local";
  return `${randomBytes(12).toString("hex")}@${domain}`;
}

/** Builds a raw message, ready to send. */
export function buildMessage(m: OutgoingMail): Buffer {
  const boundary = () => `hearth-${randomBytes(9).toString("hex")}`;
  const headers = [
    `From: ${formatAddress(m.from)}`,
    `To: ${m.to.map(formatAddress).join(", ")}`,
    ...(m.cc?.length ? [`Cc: ${m.cc.map(formatAddress).join(", ")}`] : []),
    ...(m.bcc?.length ? [`Bcc: ${m.bcc.map(formatAddress).join(", ")}`] : []),
    `Subject: ${headerText(m.subject)}`,
    `Date: ${(m.date ?? new Date()).toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${m.messageId ?? newMessageId(m.from.address)}>`,
    ...(m.inReplyTo ? [`In-Reply-To: <${m.inReplyTo}>`] : []),
    ...(m.references?.length ? [`References: ${m.references.map((r) => `<${r}>`).join(" ")}`] : []),
    "MIME-Version: 1.0",
  ];
  const part = (type: string, body: string) =>
    [
      `Content-Type: ${type}; charset=UTF-8`,
      "Content-Transfer-Encoding: base64",
      "",
      base64Lines(Buffer.from(body)),
    ].join("\r\n");
  let body = part("text/plain", m.text);
  if (m.html) {
    const b = boundary();
    body = [
      `Content-Type: multipart/alternative; boundary="${b}"`,
      "",
      `--${b}`,
      body,
      `--${b}`,
      part("text/html", m.html),
      `--${b}--`,
    ].join("\r\n");
  }
  if (m.attachments?.length) {
    const b = boundary();
    const files = m.attachments.map((a) => {
      const name = headerText(a.filename).replace(/"/g, "");
      return [
        `--${b}`,
        `Content-Type: ${a.mimeType}; name="${name}"`,
        `Content-Disposition: attachment; filename="${name}"`,
        "Content-Transfer-Encoding: base64",
        "",
        base64Lines(a.content),
      ].join("\r\n");
    });
    body = [
      `Content-Type: multipart/mixed; boundary="${b}"`,
      "",
      `--${b}`,
      body,
      ...files,
      `--${b}--`,
    ].join("\r\n");
  }
  // The top part's Content-Type header joins the message headers.
  const split = body.indexOf("\r\n\r\n");
  return Buffer.from(
    `${[...headers, body.slice(0, split)].join("\r\n")}\r\n\r\n${body.slice(split + 4)}\r\n`,
  );
}
