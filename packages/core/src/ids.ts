// Well-known identities (seeded by the first migration; never change these values), and new
// random ids.

/** The entity that represents you (a person record). */
export const OWNER_ENTITY_ID = "00000000-0000-4000-8000-000000000001";
/** The entity that represents Jarvis (an agent record), so it can be @mentioned and linked. */
export const JARVIS_ENTITY_ID = "00000000-0000-4000-8000-000000000002";

export const PRINCIPAL = {
  owner: "owner",
  jarvis: "jarvis",
  system: "system",
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** A random id of `bytes` bytes, in hex. */
export function randomHex(bytes: number): string {
  // getRandomValues, unlike randomUUID, works on a page served over plain http too.
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
