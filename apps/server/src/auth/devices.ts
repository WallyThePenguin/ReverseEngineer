// Device tokens: the desktop app works as you, but only through the few actions it needs. Its
// token is shown once, when it's paired; pairing again replaces it.
import { PRINCIPAL } from "@hearth/core";
import { createSession, type DbOrTx, session } from "@hearth/db";
import { and, eq, isNull, like } from "drizzle-orm";

/** What each kind of device may run. */
export const DEVICE_SCOPES: Record<string, string[]> = {
  desktop: [
    "voice.clean",
    "voice.command",
    "voice.command_result",
    "voice.styles",
    "chat.send",
    "conversation.get",
    // The meeting recorder.
    "meeting.record",
    "meeting.add_segments",
    "meeting.end",
    // Speech for the phone: it takes recordings to transcribe and answers them (D46).
    "GET /api/voice/jobs/next",
    "POST /api/voice/jobs/:id",
    // Hearth on the PC (D53): the tray's status line and Windows notifications. Read only.
    "system.status",
    "GET /api/desktop/notify",
  ],
};

const label = (name: string) => `device:${name}`;

/** Pairs a device: revokes its old token and makes a new one, shown once. */
export async function pairDevice(db: DbOrTx, name: string, now = new Date()): Promise<string> {
  const scopes = DEVICE_SCOPES[name];
  if (!scopes) throw new Error(`Hearth doesn't know a device called ${name}.`);
  await revokeDevice(db, name, now);
  return createSession(
    db,
    { principal: PRINCIPAL.owner, kind: "api", label: label(name), ttlDays: null, scopes },
    now,
  );
}

export async function revokeDevice(db: DbOrTx, name: string, now = new Date()): Promise<number> {
  return revokeLabelled(db, label(name), now);
}

/**
 * The browser session Hearth's own window on the PC signs in with (D53). It's a full session, so
 * it's kept to one: connecting again replaces it, and disconnecting the app signs it out.
 */
export const DESKTOP_WINDOW = "window:desktop";

export async function revokeDesktopWindow(db: DbOrTx, now = new Date()): Promise<number> {
  return revokeLabelled(db, DESKTOP_WINDOW, now);
}

/**
 * Whether the desktop app is paired now. The window's own passkey signs in only then (D69), so
 * Disconnect leaves it nothing to sign in as until you connect again.
 */
export async function desktopPaired(db: DbOrTx): Promise<boolean> {
  const rows = await db
    .select({ hash: session.tokenHash })
    .from(session)
    .where(and(eq(session.label, label("desktop")), isNull(session.revokedAt)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Unpairs a device, from Settings or `hearth device unpair`. For the desktop app that signs
 * Hearth's window on the PC out too (D53). Pairing again doesn't: it only replaces the token.
 */
export async function unpairDevice(db: DbOrTx, name: string, now = new Date()): Promise<number> {
  let n = await revokeDevice(db, name, now);
  if (name === "desktop") n += await revokeDesktopWindow(db, now);
  return n;
}

async function revokeLabelled(db: DbOrTx, name: string, now: Date): Promise<number> {
  const rows = await db
    .update(session)
    .set({ revokedAt: now })
    .where(and(eq(session.label, name), isNull(session.revokedAt)))
    .returning({ hash: session.tokenHash });
  return rows.length;
}

/** Paired devices, with when each was last seen. */
export async function listDevices(db: DbOrTx) {
  const rows = await db
    .select({ label: session.label, createdAt: session.createdAt, lastSeenAt: session.lastSeenAt })
    .from(session)
    .where(and(like(session.label, "device:%"), isNull(session.revokedAt)));
  return rows.map((r) => ({
    name: r.label.slice("device:".length),
    pairedAt: r.createdAt,
    lastSeenAt: r.lastSeenAt,
  }));
}

/**
 * Whether a device's token may make this request: only the actions it was given, and the few
 * routes named as "METHOD /path", where `:id` stands for one id.
 */
export function scopeAllows(scopes: string[], method: string, path: string): boolean {
  const m = /^\/api\/actions\/([a-z_.]+)$/.exec(path);
  if (method === "POST" && m !== null && scopes.includes(m[1]!)) return true;
  return scopes.some((s) => {
    const [verb, pattern] = s.split(" ");
    if (verb !== method || !pattern) return false;
    const re = new RegExp(`^${pattern.replace(/:id/g, "[0-9a-f-]{1,64}")}$`);
    return re.test(path);
  });
}
