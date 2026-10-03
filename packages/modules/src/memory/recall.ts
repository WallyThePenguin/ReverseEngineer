// What Jarvis remembers in a turn: every "always" note, plus topic notes whose keywords come up
// in what the turn is about. Picked by plain rules, no model call (PLAN.md section 6.2).
import { type DbOrTx, entity, memoryNote } from "@hearth/db";
import { and, asc, eq, isNull } from "drizzle-orm";

/** Keeps memory from crowding out the rest of the prompt. */
export const MEMORY_BUDGET_CHARS = 16_000;

export interface RecalledNote {
  id: string;
  title: string;
  body: string;
  scope: "always" | "topic";
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether a keyword appears in the text as a whole word or phrase, ignoring case. */
export function mentions(text: string, keyword: string): boolean {
  if (!keyword) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(keyword)}($|[^\\p{L}\\p{N}])`, "iu").test(
    text,
  );
}

export async function recallMemory(
  db: DbOrTx,
  about: string,
  budget = MEMORY_BUDGET_CHARS,
): Promise<RecalledNote[]> {
  const rows = await db
    .select({
      id: entity.id,
      title: entity.title,
      body: entity.body,
      scope: memoryNote.scope,
      keywords: memoryNote.keywords,
    })
    .from(entity)
    .innerJoin(memoryNote, eq(memoryNote.entityId, entity.id))
    .where(and(eq(entity.type, "memory_note"), isNull(entity.deletedAt)))
    .orderBy(asc(entity.createdAt));
  const picked = [
    ...rows.filter((r) => r.scope === "always"),
    ...rows.filter((r) => r.scope === "topic" && r.keywords.some((k) => mentions(about, k))),
  ];
  const out: RecalledNote[] = [];
  let used = 0;
  for (const r of picked) {
    const body = r.body ?? "";
    if (!body.trim()) continue;
    const size = r.title.length + body.length;
    if (used + size > budget) continue;
    used += size;
    out.push({ id: r.id, title: r.title, body, scope: r.scope });
  }
  return out;
}

/** Memory as it goes in the system prompt: last, and marked as data. */
export function renderMemory(notes: RecalledNote[]): string | null {
  if (notes.length === 0) return null;
  const parts = notes.map((n) => `### ${n.title} (memory ${n.id})\n${n.body.trim()}`);
  return `<memory>\n${parts.join("\n\n")}\n</memory>`;
}

/** The site and the sites it belongs to: "www.shop.example" → itself, "shop.example". */
export function siteNames(host: string): string[] {
  const labels = host.toLowerCase().split(".");
  const out: string[] = [];
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join("."));
  return out;
}

/**
 * Notes about a site (B2's per-site memory): topic notes with the site among their keywords.
 * Browsing a site shows them, so its quirks and your preferences there come along.
 */
export async function notesForSite(db: DbOrTx, host: string): Promise<RecalledNote[]> {
  const names = siteNames(host);
  const rows = await db
    .select({
      id: entity.id,
      title: entity.title,
      body: entity.body,
      scope: memoryNote.scope,
      keywords: memoryNote.keywords,
    })
    .from(memoryNote)
    .innerJoin(entity, eq(entity.id, memoryNote.entityId))
    .where(isNull(entity.deletedAt))
    .orderBy(asc(entity.title));
  return rows
    .filter((r) => r.scope === "topic" && r.keywords.some((k) => names.includes(k)))
    .slice(0, 10)
    .map(({ keywords: _k, ...r }) => ({ ...r, body: r.body ?? "" }));
}
