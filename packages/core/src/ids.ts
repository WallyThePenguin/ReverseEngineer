// Well-known identities. Seeded by the first migration; never change these values.

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
