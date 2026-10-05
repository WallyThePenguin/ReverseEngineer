// A conversation remembers reading outside content (D58). Its later turns resume the same agent
// session, which still holds what was read, so they start untrusted too, with the addresses that
// appeared in it (D25) and the sites opened before it (D30). A new conversation starts afresh.
import { conversation, entity } from "@hearth/db";
import type { Kernel } from "@hearth/kernel";
import { eq } from "drizzle-orm";
import type { TurnState } from "./tools.ts";
import { readOutsideContent } from "./trust.ts";

type ConversationRow = typeof conversation.$inferSelect;

/** The turn read outside content (see readOutsideContent): remembers what, for the badge. */
export function readFrom(state: TurnState, source: string, text: string, value?: unknown): void {
  state.taintedBy ??= source;
  readOutsideContent(state, text, value);
}

/** How many addresses a conversation keeps: the most recent ones. */
const MAX_URLS = 2000;

/** Loads the conversation, and starts the turn untrusted if it has read outside content. */
export async function restoreTaint(
  kernel: Kernel,
  cid: string,
  state: TurnState,
): Promise<ConversationRow | undefined> {
  const [conv] = await kernel.db.select().from(conversation).where(eq(conversation.entityId, cid));
  if (!conv) return conv;
  state.vouchedHosts ??= new Set();
  for (const host of conv.vouchedHosts) state.vouchedHosts.add(host);
  if (conv.taintedAt) {
    state.origin = "untrusted";
    state.taintedBy ??= conv.taintSource ?? undefined;
    for (const url of conv.seenUrls) state.seenUrls.add(url);
  }
  return conv;
}

/**
 * Keeps what this turn learned for the next one: whether it read outside content (and what), the
 * addresses it saw, and the sites it opened while still trusted. Runs however the turn ended.
 */
export async function keepTaint(
  kernel: Kernel,
  cid: string,
  state: TurnState,
  before: ConversationRow | undefined,
): Promise<void> {
  if (!before) return;
  const hosts = [...new Set([...before.vouchedHosts, ...(state.vouchedHosts ?? [])])];
  const tainted = state.origin === "untrusted";
  const urls = tainted
    ? [...new Set([...before.seenUrls, ...state.seenUrls])].slice(-MAX_URLS)
    : [];
  const had = new Set(before.seenUrls);
  const changed =
    hosts.length !== before.vouchedHosts.length ||
    (tainted && (!before.taintedAt || urls.some((u) => !had.has(u))));
  if (!changed) return;
  await kernel.db.transaction(async (tx) => {
    await tx
      .update(conversation)
      .set({
        vouchedHosts: hosts,
        ...(tainted
          ? {
              taintedAt: before.taintedAt ?? kernel.clock.now(),
              taintSource: before.taintSource ?? outsideLabel(state.taintedBy),
              seenUrls: urls,
            }
          : {}),
      })
      .where(eq(conversation.entityId, cid));
    // Its record shows what Jarvis said after reading it, so reading it lowers trust too.
    if (tainted) await tx.update(entity).set({ outside: true }).where(eq(entity.id, cid));
  });
}

const LABELS: [RegExp, string][] = [
  [/^(browser|web|page)|WebFetch|WebSearch/i, "a web page"],
  [/mail|gmail/i, "an email"],
  [/slack/i, "a Slack message"],
  [/github/i, "something on GitHub"],
  [/calendar|meeting|event/i, "a calendar invitation"],
  [/voice|heard|device/i, "words the desktop app heard"],
  [/mcp/i, "an outside app"],
];

/** What made a turn untrusted, in a few plain words for the badge. */
export function outsideLabel(source: string | undefined): string {
  if (!source) return "outside content";
  return LABELS.find(([re]) => re.test(source))?.[1] ?? "outside content";
}
