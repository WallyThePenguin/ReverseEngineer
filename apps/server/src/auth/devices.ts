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
  const rows = await db
    .update(session)
    .set({ revokedAt: now })
    .where(and(eq(session.label, label(name)), isNull(session.revokedAt)))
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

/** Whether a device's token may make this request: only the actions it was given. */
export function scopeAllows(scopes: string[], method: string, path: string): boolean {
  const m = /^\/api\/actions\/([a-z_.]+)$/.exec(path);
  return method === "POST" && m !== null && scopes.includes(m[1]!);
}
