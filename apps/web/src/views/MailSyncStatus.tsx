// How mail syncing is going, in plain words, for Settings and the Mail page. Catching up and a
// pause Gmail asked for are normal and shown quietly; only a sync that keeps failing is red (D55),
// or a pause that has kept new mail out for two hours (Gmail isn't letting up).

import { Show } from "solid-js";
import { timeNow } from "../lib/clock.ts";
import { ago, timeOn } from "../lib/format.ts";
import type { MailAccount } from "../lib/types.ts";

const count = (n: number) => n.toLocaleString("en-US");
/** Paused with nothing new for this long: say since when; for PAUSED_BAD_MS, in red. */
const PAUSED_LONG_MS = 30 * 60_000;
const PAUSED_BAD_MS = 2 * 3600_000;

export interface SyncLine {
  badge: string;
  text: string;
  tone: "ok" | "muted" | "bad";
}

/** One account's sync in a few words, and how loudly to show it. */
export function syncLine(a: MailAccount): SyncLine {
  if (a.state === "failing")
    return {
      badge: "mail failing",
      tone: "bad",
      text: a.reconnect
        ? `Google stopped accepting Hearth's access to ${a.address}. Connect it again in Settings.`
        : a.syncedAt
          ? `Mail for ${a.address} last synced ${ago(a.syncedAt)}. Hearth keeps trying.`
          : `Mail for ${a.address} hasn't synced yet. Hearth keeps trying.`,
    };
  if (a.state === "paused" && a.pausedUntil) {
    const quiet = a.syncedAt ? timeNow().getTime() - new Date(a.syncedAt).getTime() : 0;
    // "a.m." or "p.m." ends the sentence too; "tomorrow" needs its own period.
    const at = timeOn(new Date(a.pausedUntil));
    const resuming = at.endsWith(".") ? at : `${at}.`;
    return {
      badge: "mail paused",
      tone: quiet >= PAUSED_BAD_MS ? "bad" : "muted",
      text:
        a.syncedAt && quiet >= PAUSED_LONG_MS
          ? `Gmail keeps asking Hearth to slow down; last synced ${ago(a.syncedAt)}. Trying again at ${resuming}`
          : `Gmail asked Hearth to slow down; resuming at ${resuming}`,
    };
  }
  if (a.state === "catching_up" || !a.firstSyncDone)
    return {
      badge: "catching up",
      tone: "muted",
      text: a.backfill
        ? `Catching up: ${count(a.backfill.fetched)} of ~${count(a.backfill.target)}`
        : a.waiting > 0
          ? `Catching up: ${count(a.waiting)} to go`
          : "Catching up…",
    };
  return { badge: "mail", tone: "ok", text: a.syncedAt ? `synced ${ago(a.syncedAt)}` : "" };
}

const LOUDEST: MailAccount["state"][] = ["failing", "paused", "catching_up"];

/** The Mail page's line about syncing, for the account that most needs it said; else nothing. */
export function MailSyncBanner(props: { accounts: MailAccount[] }) {
  const account = () => {
    for (const state of LOUDEST) {
      const a = props.accounts.find((x) => x.state === state);
      if (a) return a;
    }
    return undefined;
  };
  return (
    <Show when={account()}>
      {(a) => (
        <p
          class={`border-b border-line bg-sunk px-4 py-2 text-sm ${syncLine(a()).tone === "bad" ? "text-bad" : "text-muted"}`}
        >
          {syncLine(a()).text}
        </p>
      )}
    </Show>
  );
}
