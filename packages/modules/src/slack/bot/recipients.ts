// Who "tell Sam" goes to, and where a channel post lands (D62), as Slack says right now: read with
// your own token, which only reads. A send's approval card leads with this, and the send refuses
// to go if it changed by the time you said yes (D33, D58). Names are written by the people
// themselves, so they're kept short and can't carry Hearth's link tags.
import { isUuid } from "@hearth/core";
import { type DbOrTx, personEmail, slackBot, slackUser, slackWorkspace } from "@hearth/db";
import { type ActionContext, ActionError, getSetting, type ReadContext } from "@hearth/kernel";
import { eq, inArray } from "drizzle-orm";
import { SlackError, type SlackUser } from "../api.ts";
import { named, openToken, slackApi } from "../save.ts";

/** What these reads need: the database, and the Slack client and vault of this process. */
export type Reader = { db: DbOrTx } & Pick<ActionContext, "service">;

export const readerOf = (ctx: ActionContext): Reader => ({
  db: ctx.tx,
  service: (name) => ctx.service(name),
});

/** A snapshot's context as a Reader: the guard gives it this process's services. */
export function snapshotReader(ctx: ReadContext & { service?<T>(name: string): T }): Reader {
  const { service } = ctx;
  if (!service) throw new ActionError("unavailable", "Slack can't be asked from here.");
  return { db: ctx.db, service };
}

/** Who a DM goes to, as its card shows them. */
export interface DmSnapshot {
  user: string;
  name: string;
  email: string | null;
  guest: boolean;
}

/** Where a channel post goes, as its card shows it. */
export interface ChannelSnapshot {
  channel: string;
  name: string;
  members: number;
  guests: number;
  /** Shared with another org (Slack Connect). */
  shared: boolean;
}

/** A name someone chose for themselves, as Hearth shows it. */
export const shown = (s: string) => named(s).replace(/\s+/g, " ").trim().slice(0, 80);

async function yourWorkspace(db: DbOrTx) {
  const [ws] = await db.select().from(slackWorkspace).limit(1);
  if (!ws) throw new ActionError("not_found", "Connect Slack with your own token first.");
  return ws;
}

/**
 * Jarvis's bot, ready to post: connected, and switched on in Settings. Like everything of D62's,
 * posting waits for slack.bot.membersOn, which starts off.
 */
export async function postingBot(db: DbOrTx) {
  const ws = await yourWorkspace(db);
  const [bot] = await db.select().from(slackBot).where(eq(slackBot.teamId, ws.teamId));
  if (!bot)
    throw new ActionError(
      "unavailable",
      "The Jarvis bot in Slack isn't connected. Connect it in Settings → Slack.",
    );
  if (!(await getSetting(db, "slack.bot.membersOn")))
    throw new ActionError(
      "unavailable",
      "The Jarvis bot in Slack is switched off. Turn it on in Settings → Slack.",
    );
  return { ws, bot };
}

/** One question to Slack, with its refusals said in words. */
async function ask<T>(call: () => Promise<T>, meanings: Record<string, string> = {}): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof ActionError) throw err;
    if (err instanceof SlackError) {
      const meaning = meanings[err.code];
      if (meaning) throw new ActionError("not_found", meaning);
      throw new ActionError("unavailable", `Slack said ${err.code}. Try again in a minute.`);
    }
    throw new ActionError("unavailable", "Slack couldn't be reached. Try again in a minute.");
  }
}

type Workspace = Awaited<ReturnType<typeof yourWorkspace>>;

/** Someone Jarvis may message: not a bot, not deactivated, and in your workspace. */
function asRecipient(u: SlackUser, ws: Workspace): DmSnapshot {
  const name = shown(u.realName || u.name);
  if (u.bot || u.id === "USLACKBOT")
    throw new ActionError(
      "invalid_input",
      `${name} is a bot or an app: the Jarvis bot messages people.`,
    );
  if (u.deleted) throw new ActionError("invalid_input", `${name} is deactivated in Slack.`);
  if (u.teamId && u.teamId !== ws.teamId)
    throw new ActionError(
      "invalid_input",
      `${name} is in another org (Slack Connect). The Jarvis bot only messages people in ${ws.teamName}.`,
    );
  return { user: u.id, name, email: u.email?.toLowerCase() ?? null, guest: Boolean(u.guest) };
}

/** Who a DM to `to` goes to: a Slack user's id, or a person in Hearth found by their email. */
export async function dmRecipient(r: Reader, to: string): Promise<DmSnapshot> {
  const ws = await yourWorkspace(r.db);
  const token = openToken(r, ws);
  const api = slackApi(r);
  if (!isUuid(to)) {
    const u = await ask(() => api.user(token, to));
    if (!u) throw new ActionError("not_found", `No one in Slack has the id ${to}.`);
    return asRecipient(u, ws);
  }
  const [linked] = await r.db
    .select({ id: slackUser.id })
    .from(slackUser)
    .where(eq(slackUser.personId, to))
    .limit(1);
  let u = linked ? await ask(() => api.user(token, linked.id)) : null;
  if (!u) {
    const emails = (
      await r.db
        .select({ a: personEmail.address })
        .from(personEmail)
        .where(eq(personEmail.personId, to))
    ).map((e) => e.a.toLowerCase());
    const everyone = emails.length ? await ask(() => api.users(token)) : [];
    u =
      everyone.find((x) => !x.deleted && x.email && emails.includes(x.email.toLowerCase())) ?? null;
  }
  if (!u)
    throw new ActionError(
      "not_found",
      "Nook can't find that person in Slack by their email. Look them up with slack.find_member.",
    );
  return asRecipient(u, ws);
}

/**
 * Where a channel post goes, and how many see it. Jarvis posts only in channels it's been invited
 * to (D62): the bot is in its members, which your token reads.
 */
export async function channelPlace(r: Reader, channelId: string): Promise<ChannelSnapshot> {
  const { ws, bot } = await postingBot(r.db);
  const token = openToken(r, ws);
  const api = slackApi(r);
  const facts = await ask(() => api.channel(token, channelId), {
    channel_not_found: "Nook can't see that channel with your Slack token.",
  });
  const name = shown(facts.name);
  if (facts.kind === "dm" || facts.kind === "group")
    throw new ActionError(
      "invalid_input",
      "That's a direct message: message people with slack.dm.",
    );
  if (facts.archived) throw new ActionError("invalid_input", `#${name} is archived.`);
  if (!facts.members.includes(bot.botUserId))
    throw new ActionError(
      "invalid_input",
      `The Jarvis bot isn't in #${name}. Invite @Jarvis there first: it posts only where it's been invited.`,
    );
  const guests = new Set(
    (await ask(() => api.users(token))).filter((u) => u.guest).map((u) => u.id),
  );
  return {
    channel: channelId,
    name,
    members: facts.members.length,
    guests: facts.members.filter((m) => guests.has(m)).length,
    shared: facts.shared,
  };
}

export interface Candidate {
  id: string;
  name: string;
  /** The name they go by in Slack, when it isn't their full name. */
  goesBy?: string;
  email: string | null;
  guest: boolean;
  /** The person they are in Hearth, by their Slack link or their email. */
  personId: string | null;
}

const MAX_CANDIDATES = 10;

/** People in your workspace whose name, email or id fits `query`, closest first. */
export async function findMembers(r: Reader, query: string) {
  const ws = await yourWorkspace(r.db);
  const q = query.trim().replace(/^@/, "").toLowerCase();
  const everyone = await ask(() => slackApi(r).users(openToken(r, ws)));
  const fit = (u: SlackUser) => {
    const words = [u.id, u.email, u.name, u.realName].filter(Boolean).map((s) => s!.toLowerCase());
    if (words.includes(q)) return 0;
    if (words.some((w) => w.startsWith(q))) return 1;
    return words.some((w) => w.includes(q)) ? 2 : null;
  };
  const found = everyone
    .filter((u) => !u.bot && !u.deleted && u.id !== "USLACKBOT")
    .filter((u) => !u.teamId || u.teamId === ws.teamId)
    .map((u) => ({ u, score: fit(u) }))
    .filter((x): x is { u: SlackUser; score: number } => x.score !== null)
    .sort((a, b) => a.score - b.score || a.u.name.localeCompare(b.u.name));
  const top = found.slice(0, MAX_CANDIDATES).map((x) => x.u);
  const people = await linkedPeople(r.db, top);
  const candidates: Candidate[] = top.map((u) => {
    const name = shown(u.realName || u.name);
    const goesBy = shown(u.name);
    return {
      id: u.id,
      name,
      ...(goesBy !== name ? { goesBy } : {}),
      email: u.email?.toLowerCase() ?? null,
      guest: Boolean(u.guest),
      personId: people.get(u.id) ?? null,
    };
  });
  return { candidates, more: found.length > top.length };
}

/** The person each user is in Hearth: linked when Slack was read in, or by email. */
async function linkedPeople(db: DbOrTx, users: SlackUser[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!users.length) return out;
  const linked = await db
    .select({ id: slackUser.id, person: slackUser.personId })
    .from(slackUser)
    .where(
      inArray(
        slackUser.id,
        users.map((u) => u.id),
      ),
    );
  for (const l of linked) if (l.person) out.set(l.id, l.person);
  const emails = users.filter((u) => !out.has(u.id) && u.email);
  if (!emails.length) return out;
  const byEmail = await db
    .select()
    .from(personEmail)
    .where(
      inArray(
        personEmail.address,
        emails.map((u) => u.email!.toLowerCase()),
      ),
    );
  for (const u of emails) {
    const p = byEmail.find((e) => e.address === u.email!.toLowerCase());
    if (p) out.set(u.id, p.personId);
  }
  return out;
}
