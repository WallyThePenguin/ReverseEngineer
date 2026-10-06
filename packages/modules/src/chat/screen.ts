// What the owner has open when they ask Jarvis something, so "this" and "it" mean something
// (plan step 10). Only the record's id and kind go into the prompt, and its title only when it's
// Hearth's own text: an email's subject is outside content, and the chat would stay untrusted for
// good (D58). Jarvis reads the record itself when it needs to, under the usual rules.
import type { DbOrTx } from "@hearth/db";
import { isOutside, liveEntity } from "../shared.ts";

export interface OnScreen {
  view?: string;
  id?: string;
  type?: string;
  /** Only for a record whose text is the owner's or Hearth's own. */
  title?: string;
}

/** Resolves what the app said is on screen; a record that's gone is left out. */
export async function onScreen(
  db: DbOrTx,
  looking: { id?: string | undefined; view?: string | undefined } | undefined,
): Promise<OnScreen | undefined> {
  if (!looking) return undefined;
  const row = looking.id ? await liveEntity(db, looking.id) : undefined;
  if (!row && !looking.view) return undefined;
  return {
    ...(looking.view ? { view: looking.view } : {}),
    ...(row
      ? {
          id: row.id,
          type: row.type,
          ...(isOutside(row) || !row.title ? {} : { title: row.title.slice(0, 200) }),
        }
      : {}),
  };
}

/** The line added to the owner's message for Jarvis. */
export function onScreenLine(s: OnScreen): string {
  if (s.id) {
    const named = s.title ? ` "${s.title.replace(/["\n\r]/g, " ")}"` : "";
    return `(On screen as the owner asks: ${s.type ?? "record"}${named}, record ${s.id}. "This" or "it" most likely means it; read it with record_read if you need what's in it.)`;
  }
  return `(On screen as the owner asks: the ${s.view} screen.)`;
}
