// Where Jarvis answers @mentions in your Slack, and what your own DM with it gets back (D62).
// Every channel starts off, and only one you're in, with no guests and not shared with another org
// can be on: Hearth checks that when you turn it on and every hour after, and turns it off (and
// tells you) when it stops being true. Group DMs are never on. Replies in a channel wait for your
// yes unless you say otherwise, since everyone there reads them.

import { createSignal, For, Show } from "solid-js";
import { ago } from "../lib/format.ts";
import { toast } from "../lib/live.ts";
import { orBack } from "../lib/orBack.ts";
import { act, useAction } from "../lib/query.ts";

interface Channel {
  id: string;
  name: string;
  kind: "channel" | "private" | "group" | "dm";
  jarvisTier: "off" | "relay" | "schedule";
  jarvisReplies: "auto" | "review";
  jarvisCheckedAt: string | null;
}

const select = "rounded-md border border-line bg-panel px-2 py-1 text-sm";
/** At most this many channels that are off are listed for a search. */
const SHOWN = 20;

/** Whether Jarvis's answers to your own DM are the answers themselves, or fixed replies. */
export function OwnerDmSwitch(props: { ownerDmAnswers: "fixed" | "full" }) {
  return (
    <label class="flex items-start gap-2">
      <input
        type="checkbox"
        class="mt-1"
        checked={props.ownerDmAnswers === "full"}
        onChange={(e) =>
          void orBack(
            e.currentTarget,
            act("slack.bot_settings", {
              ownerDmAnswers: e.currentTarget.checked ? "full" : "fixed",
            }),
            () => props.ownerDmAnswers === "full",
          )
        }
      />
      <span>
        Answer my own DMs to the Jarvis bot in full
        <span class="block text-xs text-muted">
          Off, Slack only hears "Got it, it's in Nook", then "Done" or "Needs your yes in Nook":
          Slack keeps and exports what's posted there.
        </span>
      </span>
    </label>
  );
}

function ChannelRow(props: { c: Channel }) {
  const set = async (patch: {
    tier?: Channel["jarvisTier"];
    replies?: Channel["jarvisReplies"];
  }) => {
    const r = await act<{ off?: string }>("slack.channel_set", {
      channel: props.c.id,
      tier: patch.tier ?? props.c.jarvisTier,
      ...(patch.replies ? { replies: patch.replies } : {}),
    });
    // Asking for more failed the check: the channel is off now, and this says why.
    if (r?.off) toast.show(`The Jarvis bot stopped answering in #${props.c.name}: ${r.off}`);
    return r;
  };
  return (
    <li class="flex flex-wrap items-center gap-2 border-t border-line py-2">
      <div class="min-w-40 flex-1">
        <p class="font-medium">#{props.c.name}</p>
        <Show when={props.c.jarvisTier !== "off" && props.c.jarvisCheckedAt}>
          {(at) => <p class="text-xs text-faint">Checked {ago(at())}</p>}
        </Show>
      </div>
      <select
        class={select}
        aria-label={`The Jarvis bot in #${props.c.name}`}
        value={props.c.jarvisTier}
        onChange={(e) =>
          void orBack(
            e.currentTarget,
            set({ tier: e.currentTarget.value as Channel["jarvisTier"] }),
            () => props.c.jarvisTier,
          )
        }
      >
        <option value="off">Off</option>
        <option value="relay">Pass messages on</option>
        <option value="schedule">Also share free time</option>
      </select>
      <Show when={props.c.jarvisTier !== "off"}>
        <select
          class={select}
          aria-label={`Replies in #${props.c.name}`}
          value={props.c.jarvisReplies}
          onChange={(e) =>
            void orBack(
              e.currentTarget,
              set({ replies: e.currentTarget.value as Channel["jarvisReplies"] }),
              () => props.c.jarvisReplies,
            )
          }
        >
          <option value="review">Replies wait for you</option>
          <option value="auto">Replies go out</option>
        </select>
      </Show>
    </li>
  );
}

export function SlackChannels() {
  const channels = useAction<Channel[]>("slack.channels");
  const [q, setQ] = createSignal("");
  const channelsOnly = () =>
    (channels.data ?? []).filter((c) => c.kind === "channel" || c.kind === "private");
  const on = () => channelsOnly().filter((c) => c.jarvisTier !== "off");
  const found = () => {
    const words = q().trim().toLowerCase();
    if (!words) return [];
    return channelsOnly()
      .filter((c) => c.jarvisTier === "off" && c.name.toLowerCase().includes(words))
      .slice(0, SHOWN);
  };
  return (
    <div class="space-y-1">
      <h4 class="font-medium">Channels</h4>
      <p class="text-xs text-muted">
        The Jarvis bot answers @Jarvis only in channels you turn on here: ones you're in, with no
        guests and not shared with another org. Invite @Jarvis there too. Group DMs are never on.
      </p>
      <ul>
        <For each={on()}>{(c) => <ChannelRow c={c} />}</For>
      </ul>
      <input
        class="w-full rounded border border-line bg-panel px-2 py-1 text-sm"
        placeholder="Find a channel to turn on"
        aria-label="Find a Slack channel"
        value={q()}
        onInput={(e) => setQ(e.currentTarget.value)}
      />
      <ul>
        <For each={found()}>{(c) => <ChannelRow c={c} />}</For>
      </ul>
    </div>
  );
}
