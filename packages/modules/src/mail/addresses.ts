// Addresses as a draft takes them. Yours are kept as you typed them, so saving what you wrote never
// fails on one you're still typing; Send checks them (send.ts). Anyone else's must be addresses.
import type { MailAddress } from "@hearth/db";
import { ActionError } from "@hearth/kernel";
import { z } from "zod";
import { cleanName } from "./mime.ts";

const address = z.string().trim().max(320).describe('An email address, or "Name <address>".');
export const addresses = z.array(address).max(50);

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
