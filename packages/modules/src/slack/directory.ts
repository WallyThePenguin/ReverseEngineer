// Reading Slack's answers: messages, people and channels as Hearth keeps them, and the reads
// "tell Sam" needs with your own token (D62): everyone in the workspace, who's in a channel, and
// what's been posted in a place since a time, with the outbox id on each of Jarvis's posts. These
// are all reads; api.ts USER_TOKEN_METHODS lists them, and your token is never used to write.
import type { Raw, ReadBackPage, SlackChannelFacts, SlackMessage, SlackUser } from "./api.ts";

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** One Web API call, already holding its token: Slack's answer. */
export type Call = (method: string, params: Record<string, string>) => Promise<Raw>;

/**
 * The event type of the metadata on every post Jarvis's outbox makes, carrying the row's id: how a
 * post that may have gone out is told apart from one that didn't (D62).
 */
export const OUTBOX_EVENT = "hearth_outbox";

/** The outbox row a post came from, from its metadata; only Jarvis's outbox writes that. */
function outboxIdOf(m: Raw): string | undefined {
  const meta = (m.metadata as Raw | undefined) ?? {};
  if (meta.event_type !== OUTBOX_EVENT) return undefined;
  return str((meta.event_payload as Raw | undefined)?.id);
}

export function messageOf(m: Raw): SlackMessage {
  return {
    ts: String(m.ts),
    user: str(m.user),
    botId: str(m.bot_id),
    text: str(m.text) ?? "",
    threadTs: str(m.thread_ts),
    subtype: str(m.subtype),
    replyCount: typeof m.reply_count === "number" ? m.reply_count : undefined,
    latestReply: str(m.latest_reply),
    outboxId: outboxIdOf(m),
  };
}

/** A user as users.info and users.list describe them. */
export function userOf(u: Raw, id = String(u.id)): SlackUser {
  const profile = (u.profile as Raw | undefined) ?? {};
  const realName = str(profile.real_name) || str(u.real_name);
  return {
    id,
    name: str(profile.display_name) || realName || str(u.name) || id,
    ...(realName ? { realName } : {}),
    email: str(profile.email),
    bot: Boolean(u.is_bot),
    guest: Boolean(u.is_restricted || u.is_ultra_restricted),
    deleted: Boolean(u.deleted),
    teamId: str(u.team_id),
  };
}

const cursorOf = (r: Raw) => str((r.response_metadata as Raw | undefined)?.next_cursor) ?? "";

/** Every page of a list Slack pages with cursors, up to `pages` of them. */
async function allPages(
  call: Call,
  method: string,
  params: Record<string, string>,
  pages: number,
  items: (r: Raw) => unknown[],
): Promise<unknown[]> {
  const out: unknown[] = [];
  let cursor = "";
  for (let page = 0; page < pages; page++) {
    const r = await call(method, { ...params, ...(cursor ? { cursor } : {}) });
    out.push(...items(r));
    cursor = cursorOf(r);
    if (!cursor) break;
  }
  return out;
}

/** Pages of a read-back: past this many, a busy place is taken as read (see readBackWith). */
const READ_BACK_PAGES = 5;

/**
 * What's been posted in a place since `oldest`, or in one of its threads, with each post's outbox
 * id. The metadata only comes back when asked for (include_all_metadata).
 */
export async function readBackWith(
  call: Call,
  channel: string,
  page: ReadBackPage,
): Promise<SlackMessage[]> {
  const params = {
    channel,
    oldest: page.oldest,
    limit: "200",
    inclusive: "true",
    include_all_metadata: "true",
    ...(page.threadTs ? { ts: page.threadTs } : {}),
  };
  const method = page.threadTs ? "conversations.replies" : "conversations.history";
  const raw = await allPages(
    call,
    method,
    params,
    READ_BACK_PAGES,
    (r) => (r.messages as Raw[]) ?? [],
  );
  return (raw as Raw[]).map(messageOf);
}

/** The reads "tell Sam" needs with your own token. */
export function directoryReads(call: (token: string) => Call) {
  return {
    async users(token: string): Promise<SlackUser[]> {
      const raw = await allPages(call(token), "users.list", { limit: "200" }, 50, (r) =>
        ((r.members as Raw[]) ?? []).filter((u) => typeof u.id === "string"),
      );
      return (raw as Raw[]).map((u) => userOf(u));
    },
    async channel(token: string, id: string): Promise<SlackChannelFacts> {
      const r = await call(token)("conversations.info", { channel: id });
      const c = (r.channel as Raw | undefined) ?? {};
      const kind = c.is_im ? "dm" : c.is_mpim ? "group" : c.is_private ? "private" : "channel";
      const members = await allPages(
        call(token),
        "conversations.members",
        { channel: id, limit: "1000" },
        10,
        (m) => ((m.members as unknown[]) ?? []).filter((u) => typeof u === "string"),
      );
      return {
        id,
        name: str(c.name) ?? id,
        kind,
        archived: Boolean(c.is_archived),
        shared: Boolean(c.is_ext_shared || c.is_shared || c.is_pending_ext_shared),
        members: members as string[],
      };
    },
    readBack: (token: string, channel: string, page: ReadBackPage) =>
      readBackWith(call(token), channel, page),
  };
}
