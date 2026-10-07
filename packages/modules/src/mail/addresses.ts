// Addresses as a draft takes them. Yours are kept as you typed them, so saving what you wrote never
// fails on one you're still typing; Send checks them (send.ts). Anyone else's must be addresses.
import type { MailAddress } from "@hearth/db";
import { ActionError } from "@hearth/kernel";
import { z } from "zod";
import { cleanName } from "./mime.ts";

// Loose for everyone, as a schema can't tell who's asking: a long paste of yours still saves, and
// Send names what's wrong with it. Jarvis and outside agents keep to the usual limits (withinLimits).
const address = z.string().trim().max(4000).describe('An email address, or "Name <address>".');
export const addresses = z.array(address).max(500);
export const draftSubject = z.string().max(2000);

/** What Jarvis or an outside agent writes into a draft keeps to the usual limits. */
export function withinLimits(i: {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
}) {
  for (const list of [i.to, i.cc, i.bcc]) {
    if (list && list.length > 50)
      throw new ActionError("invalid_input", "At most 50 addresses each in To, Cc and Bcc.");
    const long = list?.find((a) => a.trim().length > 320);
    if (long) throw new ActionError("invalid_input", `"${long.slice(0, 40)}…" is too long.`);
  }
  if ((i.subject?.length ?? 0) > 500)
    throw new ActionError("invalid_input", "A subject is at most 500 characters.");
}

/** "Ana Silva <ana@x.example>" or "ana@x.example" → an address, or null if it isn't one. */
export function parseAddress(raw: string): MailAddress | null {
  const m =
    raw.trim().match(/^(?:"?([^"<]*?)"?\s*)?<([^<>\s]+@[^<>\s]+)>$/) ??
    raw.trim().match(/^()([^<>\s]+@[^<>\s]+)$/);
  if (!m || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(m[2]!)) return null;
  return clean({ address: m[2]!, name: m[1] });
}

/** An address as a draft keeps it: lower-case, with a name that's safe to show. */
export function clean(a: MailAddress): MailAddress {
  const name = cleanName(a.name);
  return { address: a.address.toLowerCase(), ...(name ? { name } : {}) };
}

/** The addresses given; `asTyped` (yours) keeps one that isn't an address as it was typed. */
export function parseAll(list: string[] | undefined, asTyped: boolean): MailAddress[] | undefined {
  if (!list) return undefined;
  return list
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => {
      const a = parseAddress(raw);
      if (a) return a;
      if (asTyped) return { address: raw };
      throw new ActionError("invalid_input", `"${raw}" isn't an email address.`);
    });
}

type Recipients = Record<"to" | "cc" | "bcc", MailAddress[]>;

/** The first recipient that isn't an address (one you were still typing), or null. */
export function notAnAddress(d: Recipients): string | null {
  return [...d.to, ...d.cc, ...d.bcc].find((a) => !parseAddress(a.address))?.address ?? null;
}
