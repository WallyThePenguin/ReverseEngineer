// Which way in a sign-in page offers (D69). A passkey works only at the address it was made at:
// Hearth's own, or the desktop app's window on this PC (http://localhost:<port>) with a Windows
// Hello passkey of its own. Anywhere else no passkey can work, so it never offers one.

export type WayIn = "passkey" | "hello" | "browser";

export function wayIn(
  page: { origin: string; hostname: string },
  me: { origin?: string; localPasskey?: boolean },
): WayIn {
  // An older Hearth doesn't say: as before, your passkey.
  if (!me.origin || page.origin === me.origin) return "passkey";
  if (me.localPasskey && page.hostname === "localhost") return "hello";
  return "browser";
}

/** The window's own passkey can be made here: this PC's address, by name, not Hearth's own. */
export const windowPasskeyHere = (page: { origin: string; hostname: string }, origin: string) =>
  page.origin !== origin && page.hostname === "localhost";

/** Where "Connect in your browser" goes: Settings, at Desktop app, at Hearth's own address. */
export const connectLink = (origin: string) => `${origin}/settings?connect=desktop`;
