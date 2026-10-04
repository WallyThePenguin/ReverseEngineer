// Mentions inside markdown bodies: <m-ref type="task" id="...">Label</m-ref>.
// The server re-derives links from these on every save (PLAN.md section 5.3).

export interface Mention {
  type: string;
  id: string;
  label: string;
  /**
   * Which occurrence of this target among the tags without a `mid` (0, 1, 2...): the link anchor
   * for those.
   */
  occurrence: number;
  /** Character offset of the tag in the body. */
  index: number;
  /**
   * The tag's own id (its data-mid), written when the editor inserted it: the link anchor, which
   * stays the same however the text around it changes (D59).
   */
  mid?: string;
}

const MID = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * The anchor of a mention's link, and so its dedupe key: its own id when it has one, else which
 * occurrence of its target it is (tags written before ids, or by Jarvis).
 */
export function mentionAnchor(m: Pick<Mention, "occurrence" | "mid">): string {
  return m.mid ? `mid:${m.mid}` : `#${m.occurrence}`;
}

/** A new id for a mention tag the editor inserts. */
export function newMentionId(): string {
  // getRandomValues, unlike randomUUID, works on a page served over plain http too.
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const TAG = /<m-ref\s+([^>]*)>([\s\S]*?)<\/m-ref>/g;
const ATTR = /([a-z-]+)="([^"]*)"/g;

export function escapeText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function unescapeText(text: string): string {
  return text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

function escapeAttr(value: string): string {
  return escapeText(value).replaceAll('"', "&quot;");
}

export function renderMention(m: {
  type: string;
  id: string;
  label: string;
  mid?: string;
}): string {
  const mid = m.mid ? ` data-mid="${escapeAttr(m.mid)}"` : "";
  return `<m-ref type="${escapeAttr(m.type)}" id="${escapeAttr(m.id)}"${mid}>${escapeText(m.label)}</m-ref>`;
}

export function parseMentions(body: string): Mention[] {
  const out: Mention[] = [];
  const seen = new Map<string, number>();
  for (const match of body.matchAll(TAG)) {
    const attrs: Record<string, string> = {};
    for (const a of (match[1] ?? "").matchAll(ATTR)) {
      attrs[a[1]!] = unescapeText((a[2] ?? "").replaceAll("&quot;", '"'));
    }
    const { type, id } = attrs;
    if (!type || !id) continue;
    const key = `${type}:${id}`;
    const label = unescapeText(match[2] ?? "");
    const mid = attrs["data-mid"];
    // A pasted copy of a tag shares its id, and so its link: it never re-asks an old question.
    if (mid && MID.test(mid)) {
      out.push({ type, id, label, occurrence: 0, index: match.index, mid });
      continue;
    }
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    out.push({ type, id, label, occurrence, index: match.index });
  }
  return out;
}

/** Plain text for search and previews: tags become their labels. */
export function stripMentions(body: string): string {
  return body.replace(TAG, (_all, _attrs, label: string) => `@${unescapeText(label)}`);
}

/**
 * The paragraph a mention sits in, as plain text. When you write "@Jarvis can you ..." in a note,
 * this is what Jarvis is being asked.
 */
export function mentionContext(body: string, index: number): string {
  const start = body.lastIndexOf("\n\n", index);
  const end = body.indexOf("\n\n", index);
  const para = body.slice(start === -1 ? 0 : start + 2, end === -1 ? body.length : end);
  return stripMentions(para).trim();
}

// The editing form used by the plain-text editor before the rich editor lands (M4):
// @[Label](type:id). It converts losslessly to and from the stored form.
const EDIT = /@\[((?:[^\]\\]|\\.)*)\]\(([a-z_]+):([0-9a-f-]{36})\)/gi;

export function toEditForm(body: string): string {
  return body.replace(TAG, (all, attrs: string, label: string) => {
    const a: Record<string, string> = {};
    for (const m of attrs.matchAll(ATTR)) a[m[1]!] = m[2] ?? "";
    if (!a.type || !a.id) return all;
    const text = unescapeText(label).replace(/[\]\\]/g, (c) => `\\${c}`);
    return `@[${text}](${a.type}:${a.id})`;
  });
}

export function fromEditForm(text: string): string {
  return text.replace(EDIT, (_all, label: string, type: string, id: string) =>
    renderMention({ type, id: id.toLowerCase(), label: label.replace(/\\(.)/g, "$1") }),
  );
}
