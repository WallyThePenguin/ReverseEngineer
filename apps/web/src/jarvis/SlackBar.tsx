// The bar over a Slack member's conversation with Jarvis (D62). The conversation itself is
// read-only: only their turns write to it, and your turn there would carry your data into their
// next one. From here you reply as Jarvis (one of your own sends), ask Jarvis about it in a new
// conversation of yours, set how far Jarvis goes for them or block them, or pause it.

import { createSignal, For, Show } from "solid-js";
import { Badge, Button } from "../components/ui.tsx";
import { toast } from "../lib/live.ts";
import { layout } from "../lib/panes.ts";
import { act, useAction } from "../lib/query.ts";
import {
  askAbout,
  PAUSES,
  pausedNow,
  placeOf,
  replyAsJarvis,
  type SlackConversation,
  TIER_LABEL,
} from "../lib/slack.ts";

const select = "rounded-md border border-line bg-panel px-2 py-1 text-sm";

export function SlackBar(props: { id: string }) {
  const c = useAction<SlackConversation>("slack.conversation", () => ({ id: props.id }));
  const [reply, setReply] = createSignal("");
  const [replying, setReplying] = createSignal(false);

  const send = async (conv: SlackConversation) => {
    const call = replyAsJarvis(conv, reply());
    if (!call) return;
    if (await act(call.action, call.input)) {
      setReply("");
      setReplying(false);
      toast.show("Sent as Jarvis.");
    }
  };
  const ask = async () => {
    const r = await act<{ conversationId: string }>("chat.send", { text: askAbout(props.id) });
    if (r) layout.open({ view: "chat", id: r.conversationId }, { beside: true });
  };
  const pause = (hours: number) => void act("slack.conversation_pause", { id: props.id, hours });

  return (
    <Show when={c.data}>
      {(conv) => (
        <div class="space-y-2 border-b border-line bg-sunk px-4 py-2 text-sm">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-medium">{placeOf(conv())}</span>
            <Show when={conv().channel}>
              {(ch) => <Badge>{`Channel: ${TIER_LABEL[ch().tier]}`}</Badge>}
            </Show>
            <Show when={pausedNow(conv())}>
              <Badge tone="warn">Paused</Badge>
            </Show>
            <Show when={conv().heldReplies > 0}>
              <Badge tone="jarvis">A reply waits for your yes</Badge>
            </Show>
            <span class="flex-1" />
            <Button small onClick={() => setReplying(!replying())}>
              Reply as Jarvis
            </Button>
            <Button small kind="jarvis" onClick={() => void ask()}>
              Ask Jarvis about this
            </Button>
            <Show
              when={pausedNow(conv())}
              fallback={
                <select
                  class={select}
                  aria-label="Pause Jarvis here"
                  value=""
                  onChange={(e) => pause(Number(e.currentTarget.value))}
                >
                  <option value="" disabled>
                    Pause…
                  </option>
                  <For each={PAUSES}>{(p) => <option value={p.hours}>{p.label}</option>}</For>
                </select>
              }
            >
              <Button small onClick={() => pause(0)}>
                Resume
              </Button>
            </Show>
          </div>
          <For each={conv().people}>
            {(p) => (
              <div class="flex flex-wrap items-center gap-2">
                <span class="flex-1">
                  {p.name} <span class="text-xs text-faint">{p.id}</span>
                  <Show when={p.notAMember}>
                    {(why) => <span class="text-xs text-warn"> · never answered: {why()}</span>}
                  </Show>
                </span>
                <select
                  class={select}
                  aria-label={`What Jarvis does for ${p.name}`}
                  value={p.tier}
                  onChange={(e) =>
                    void act("slack.member_set", { user: p.id, tier: e.currentTarget.value })
                  }
                >
                  <option value="relay">{TIER_LABEL.relay}</option>
                  <option value="schedule">{TIER_LABEL.schedule}</option>
                  <option value="blocked">{TIER_LABEL.blocked}</option>
                </select>
                <Show when={p.tier !== "blocked"}>
                  <Button
                    small
                    kind="danger"
                    onClick={() =>
                      confirm(`Block ${p.name}? Jarvis stops answering them.`) &&
                      void act("slack.member_set", { user: p.id, tier: "blocked" })
                    }
                  >
                    Block
                  </Button>
                </Show>
              </div>
            )}
          </For>
          <Show when={replying()}>
            <form
              class="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void send(conv());
              }}
            >
              <textarea
                class="min-w-0 flex-1 rounded border border-line bg-panel px-2 py-1"
                rows={2}
                maxLength={4000}
                placeholder="What Jarvis says, as it is"
                aria-label="Reply as Jarvis"
                value={reply()}
                onInput={(e) => setReply(e.currentTarget.value)}
              />
              <Button small kind="primary" submit disabled={!reply().trim()}>
                Send
              </Button>
            </form>
          </Show>
        </div>
      )}
    </Show>
  );
}
