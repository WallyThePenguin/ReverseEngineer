// Today's box under the greeting: ask Jarvis anything, or add a task with its date. Enter asks
// Jarvis, whose answer opens beside Today; a line that names a time ("dentist fri 3pm") also offers
// itself as a task due then, one tap away, without waiting for Jarvis. Under it, what you start
// most: planning the day, a task, an email. Each does what it says once: a tap while it's on its
// way, or a double-click's second click, does nothing more.

import { createMemo, createSignal, type JSX, Show } from "solid-js";
import { Icon, type IconName } from "../../components/icons.tsx";
import { JarvisMark } from "../../components/Mark.tsx";
import { jarvis } from "../../jarvis/JarvisPane.tsx";
import { due } from "../../lib/format.ts";
import { toast } from "../../lib/live.ts";
import { askNewTask } from "../../lib/newTask.ts";
import { act, useAction } from "../../lib/query.ts";
import { quickAdd } from "../../lib/quickadd.ts";
import { blankDraft, offerAsTask } from "../../lib/today.ts";
import type { MailDraft } from "../../lib/types.ts";
import type { When } from "../../lib/when.ts";
import type { Go } from "./parts.tsx";

/** A chip under the box. A double-click's second click (detail 2) isn't a second tap. */
function Chip(props: {
  icon: IconName;
  onClick: () => void;
  busy?: boolean;
  class?: string;
  children: JSX.Element;
}) {
  return (
    <button
      type="button"
      class={`inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-sm aria-busy:opacity-60 md:min-h-8 ${props.class ?? "shrink-0 border border-line bg-panel text-muted hover:bg-sunk hover:text-ink"}`}
      aria-busy={props.busy || undefined}
      data-chip
      onClick={(e) => e.detail < 2 && props.onClick()}
    >
      <Icon name={props.icon} size={15} class={props.class ? "" : "text-faint"} />
      {props.children}
    </button>
  );
}

export function AskBar(props: { go: Go; now: Date; class?: string }) {
  const [text, setText] = createSignal("");
  const box = { get: text, set: setText };
  let chips!: HTMLDivElement;
  // Read on Today's clock, so "in 20 min" moves on with it. The task made is the one the chip
  // shows, and the toast says the same.
  const offered = createMemo(() => offerAsTask(text(), props.now));
  // Kept on show while it's added, so a second click doesn't land on a chip sliding under it.
  const [adding, setAdding] = createSignal<When | null>(null);
  const task = () => adding() ?? offered();
  const drafts = useAction<MailDraft[]>("mail.drafts");

  // What's on its way; until it's back, the chips do nothing more.
  const [busy, setBusy] = createSignal<"plan" | "task" | "email" | null>(null);
  const once = async (what: "plan" | "task" | "email", run: () => Promise<unknown>) => {
    if (busy()) return;
    setBusy(what);
    try {
      await run();
    } finally {
      setBusy(null);
    }
  };

  /** Starts a new conversation with what's typed (or a chip's words), and shows it. */
  const ask = async (words?: string) => {
    const send = (q: string) => act<{ conversationId: string }>("chat.send", { text: q });
    const r = words ? await send(words) : await quickAdd(box, send);
    if (!r) return;
    jarvis.setConversationId(r.conversationId);
    jarvis.toggle(true);
  };

  const addTask = (w: When) =>
    once("task", async () => {
      setAdding(w);
      const had = chips.contains(document.activeElement);
      const made = await quickAdd(box, () => act<{ id: string }>("task.create", w)).finally(() =>
        setAdding(null),
      );
      // The chip that was used has gone: the one in its place takes the focus.
      if (had) chips.querySelector<HTMLElement>("[data-chip]")?.focus();
      if (made)
        toast.show(`Added “${w.title}”, due ${due(w.dueAt, w.dueIsDate)?.text ?? "then"}.`, "ok", {
          label: "Open",
          run: () => props.go({ view: "task", id: made.id }),
        });
    });

  // A new message is written at the top of Mail; one already started and still empty is used.
  const writeEmail = () =>
    once("email", async () => {
      if (blankDraft(drafts.data) || (await act("mail.draft", { text: "" })))
        props.go({ view: "mail" });
    });

  // What's typed goes with it, to the top of the new task.
  const newTask = () => {
    askNewTask(true, text().trim());
    setText("");
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
      <div
        ref={chips}
        class="-mx-4 mt-2.5 flex items-center gap-2 overflow-x-auto px-4 md:mx-0 md:px-0"
      >
        <Show
          when={task()}
          fallback={
            <>
              <Chip
                icon="today"
                busy={busy() === "plan"}
                onClick={() => void once("plan", () => ask("Plan my day"))}
              >
                Plan my day
              </Chip>
              <Chip icon="plus" onClick={newTask}>
                New task
              </Chip>
              <Chip icon="mail" busy={busy() === "email"} onClick={() => void writeEmail()}>
                Write email
              </Chip>
            </>
          }
        >
          {(w) => (
            <Chip
              icon="plus"
              busy={busy() === "task"}
              class="min-w-0 bg-accent-soft text-accent hover:underline"
              onClick={() => void addTask(w())}
            >
              <span class="truncate">
                Add task “{w().title}” · due {due(w().dueAt, w().dueIsDate)?.text}
              </span>
            </Chip>
          )}
        </Show>
      </div>
    </div>
  );
}
