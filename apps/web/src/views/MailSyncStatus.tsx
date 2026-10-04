// How mail syncing is going, in plain words, for Settings and the Mail page. Catching up and a
// pause Gmail asked for are normal and shown quietly; only a sync that keeps failing is red (D55).

import { Show } from "solid-js";
import { ago, time } from "../lib/format.ts";
import type { MailAccount } from "../lib/types.ts";

const count = (n: number) => n.toLocaleString("en-US");

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
  if (a.state === "paused" && a.pausedUntil)
    return {
      badge: "mail paused",
      tone: "muted",
      // The time ends in "a.m." or "p.m.", which ends the sentence too.
      text: `Gmail asked Hearth to slow down; resuming at ${time(new Date(a.pausedUntil))}`,
    };
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
