// Today's box under the greeting: ask Jarvis anything, or add a task with its date. Enter asks
// Jarvis, whose answer opens beside Today; a line that names a time ("dentist fri 3pm") also offers
// itself as a task due then, one tap away, without waiting for Jarvis. Under it, what you start
// most: planning the day, a task, an email.

import { createMemo, createSignal, Show } from "solid-js";
import { Icon, type IconName } from "../../components/icons.tsx";
import { JarvisMark } from "../../components/Mark.tsx";
import { jarvis } from "../../jarvis/JarvisPane.tsx";
import { due } from "../../lib/format.ts";
import { toast } from "../../lib/live.ts";
import { askNewTask } from "../../lib/newTask.ts";
import { act } from "../../lib/query.ts";
import { quickAdd } from "../../lib/quickadd.ts";
import { offerAsTask } from "../../lib/today.ts";
import { readWhen } from "../../lib/when.ts";
import type { Go } from "./parts.tsx";

/** A chip under the box. */
function Chip(props: { icon: IconName; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      class="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border border-line bg-panel px-3 text-sm text-muted hover:bg-sunk hover:text-ink md:min-h-8"
      onClick={props.onClick}
    >
      <Icon name={props.icon} size={15} class="text-faint" />
      {props.children}
    </button>
  );
}

export function AskBar(props: { go: Go; class?: string }) {
  const [text, setText] = createSignal("");
  const box = { get: text, set: setText };
  const task = createMemo(() => offerAsTask(text()));

  /** Starts a new conversation with what's typed (or a chip's words), and shows it. */
  const ask = async (words?: string) => {
    const send = (q: string) => act<{ conversationId: string }>("chat.send", { text: q });
    const r = words ? await send(words) : await quickAdd(box, send);
    if (!r) return;
    jarvis.setConversationId(r.conversationId);
    jarvis.toggle(true);
  };

  const addTask = async () => {
    const w = task();
    if (!w) return;
    // Read again as it's added, so "in 20 min" counts from now.
    const made = await quickAdd(box, (q) =>
      act<{ id: string }>("task.create", readWhen(q) ?? { title: q }),
    );
    if (made)
      toast.show(`Added “${w.title}”, due ${due(w.dueAt, w.dueIsDate)?.text ?? "then"}.`, "ok", {
        label: "Open",
        run: () => props.go({ view: "task", id: made.id }),
      });
  };

  const writeEmail = async () => {
    // A new message is written at the top of Mail.
    if (await act("mail.draft", { text: "" })) props.go({ view: "mail" });
  };

  return (
    <div class={props.class}>
      <form
        class="flex items-center gap-2.5 rounded-xl border border-line bg-panel py-1.5 pr-1.5 pl-3 shadow-card focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25"
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
      >
        <JarvisMark size={18} />
        <input
          class="min-h-9 min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint"
          aria-label="Ask Jarvis or add a task"
          placeholder="Ask Jarvis or add a task…"
          enterkeyhint="send"
          // The box around it shows where you're typing; a second ring inside it would be noise.
          style={{ outline: "none" }}
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
        />
        <Show when={text().trim()}>
          <button
            type="submit"
            class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-on-fill"
            aria-label="Ask Jarvis"
            title="Ask Jarvis (Enter)"
          >
            <Icon name="send" size={16} />
          </button>
        </Show>
      </form>
      {/* One line, even on a phone: it scrolls sideways rather than taking two. */}
      <div class="-mx-4 mt-2.5 flex items-center gap-2 overflow-x-auto px-4 md:mx-0 md:px-0">
        <Show
          when={task()}
          fallback={
            <>
              <Chip icon="today" onClick={() => void ask("Plan my day")}>
                Plan my day
              </Chip>
              <Chip icon="plus" onClick={() => askNewTask(true)}>
                New task
              </Chip>
              <Chip icon="mail" onClick={() => void writeEmail()}>
                Write email
              </Chip>
            </>
          }
        >
          {(w) => (
            <button
              type="button"
              class="inline-flex min-h-11 min-w-0 items-center gap-1.5 rounded-full bg-accent-soft px-3 text-sm text-accent hover:underline md:min-h-8"
              onClick={() => void addTask()}
            >
              <Icon name="plus" size={15} />
              <span class="truncate">
                Add task “{w().title}” · due {due(w().dueAt, w().dueIsDate)?.text}
              </span>
            </button>
          )}
        </Show>
      </div>
    </div>
  );
}
