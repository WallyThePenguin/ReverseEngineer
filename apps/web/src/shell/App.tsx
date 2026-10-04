// The app: sign-in gate, then the shell (sidebar, split panes, Jarvis, Cmd+K).

import { QueryClientProvider } from "@tanstack/solid-query";
import {
  createEffect,
  createResource,
  createSignal,
  ErrorBoundary,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";
import { Login } from "../auth/Login.tsx";
import { UpdateNotice } from "../components/UpdateNotice.tsx";
import { Kbd, PaneContext } from "../components/ui.tsx";
import { ChatView } from "../jarvis/Conversation.tsx";
import { JarvisPane, jarvis } from "../jarvis/JarvisPane.tsx";
import { getMe, setSignedOutHandler } from "../lib/api.ts";
import { forgetAllDocs } from "../lib/docStore.ts";
import { listHotkeys, useHotkeys } from "../lib/hotkeys.ts";
import { live, queryClient, toast } from "../lib/live.ts";
import { narrow } from "../lib/narrow.ts";
import { type ListView, layout, type Pane, type PaneRoute } from "../lib/panes.ts";
import { Activity } from "../views/Activity.tsx";
import { Browser } from "../views/Browser.tsx";
import { Calendar } from "../views/Calendar.tsx";
import { Canvases, CanvasView } from "../views/Canvas.tsx";
import { Inbox } from "../views/Inbox.tsx";
import { Mail } from "../views/Mail.tsx";
import { MailThreadPane } from "../views/MailThread.tsx";
import { Memory } from "../views/Memory.tsx";
import { Notes, NoteView } from "../views/Notes.tsx";
import { People } from "../views/People.tsx";
import { RecordView } from "../views/Record.tsx";
import { Settings } from "../views/Settings.tsx";
import { Sheets, SheetView } from "../views/Sheets.tsx";
import { Tasks } from "../views/Tasks.tsx";
import { TaskView } from "../views/TaskView.tsx";
import { Trash } from "../views/Trash.tsx";
import { Voice } from "../views/Voice.tsx";
import { CommandPalette } from "./CommandPalette.tsx";
import { Sidebar, useWaiting } from "./Sidebar.tsx";
import { Crashed, PaneCrashed, Reconnecting, Unreachable, useAutoRetry } from "./Status.tsx";
import { TabBar } from "./TabBar.tsx";

function PaneView(props: { route: PaneRoute; index: number }) {
  const id = () => ("id" in props.route ? props.route.id : "");
  return (
    <Switch>
      <Match when={props.route.view === "inbox"}>
        <Inbox pane={props.index} />
      </Match>
      <Match when={props.route.view === "mail"}>
        <Mail pane={props.index} />
      </Match>
      <Match when={props.route.view === "thread"}>
        <MailThreadPane id={id()} pane={props.index} />
      </Match>
      <Match when={props.route.view === "tasks"}>
        <Tasks pane={props.index} />
      </Match>
      <Match when={props.route.view === "notes"}>
        <Notes pane={props.index} />
      </Match>
      <Match when={props.route.view === "canvases"}>
        <Canvases pane={props.index} />
      </Match>
      <Match when={props.route.view === "canvas"}>
        <CanvasView id={id()} pane={props.index} />
      </Match>
      <Match when={props.route.view === "sheets"}>
        <Sheets pane={props.index} />
      </Match>
      <Match when={props.route.view === "sheet"}>
        <SheetView id={id()} pane={props.index} />
      </Match>
      <Match when={props.route.view === "people"}>
        <People pane={props.index} />
      </Match>
      <Match when={props.route.view === "calendar"}>
        <Calendar pane={props.index} />
      </Match>
      <Match when={props.route.view === "memory"}>
        <Memory pane={props.index} />
      </Match>
      <Match when={props.route.view === "voice"}>
        <Voice />
      </Match>
      <Match when={props.route.view === "browser"}>
        <Browser />
      </Match>
      <Match when={props.route.view === "activity"}>
        <Activity />
      </Match>
      <Match when={props.route.view === "settings"}>
        <Settings />
      </Match>
      <Match when={props.route.view === "trash"}>
        <Trash pane={props.index} />
      </Match>
      <Match when={props.route.view === "task"}>
        <TaskView id={id()} pane={props.index} />
      </Match>
      <Match when={props.route.view === "note"}>
        <NoteView id={id()} pane={props.index} />
      </Match>
      <Match when={props.route.view === "chat"}>
        <ChatView id={id()} />
      </Match>
      <Match when={props.route.view === "record"}>
        <RecordView id={id()} pane={props.index} />
      </Match>
    </Switch>
  );
}

function Shortcuts(props: { onClose: () => void }) {
  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={props.onClose}
    >
      <div class="max-h-[80vh] w-[min(520px,92vw)] overflow-auto rounded-xl border border-line bg-panel p-5 shadow-2xl">
        <h2 class="mb-3 font-semibold">Keyboard shortcuts</h2>
        <ul class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <For each={listHotkeys()}>
            {(h) => (
              <>
                <li>
                  <Kbd>{h.keys}</Kbd>
                </li>
                <li class="text-muted">{h.label}</li>
              </>
            )}
          </For>
        </ul>
      </div>
    </div>
  );
}

function Shell(props: { onSignOut: () => void }) {
  const [palette, setPalette] = createSignal(false);
  const [help, setHelp] = createSignal(false);
  const [menu, setMenu] = createSignal(false);
  const waiting = useWaiting();
  onMount(() => {
    live.start();
    // The home screen's "Talk to Jarvis" shortcut.
    if (new URLSearchParams(location.search).has("jarvis")) jarvis.toggle(true);
  });
  onCleanup(() => live.stop());

  const go = (view: ListView) => () => layout.open({ view });
  useHotkeys([
    {
      keys: "mod+k",
      run: () => setPalette(!palette()),
      inInputs: true,
      label: "Search, commands, ask Jarvis",
    },
    { keys: "/", run: () => setPalette(true) },
    { keys: "mod+j", run: () => jarvis.toggle(), inInputs: true, label: "Show or hide Jarvis" },
    { keys: "g i", run: go("inbox"), label: "Go to Inbox" },
    { keys: "g e", run: go("mail"), label: "Go to Mail" },
    { keys: "g t", run: go("tasks"), label: "Go to Tasks" },
    { keys: "g n", run: go("notes"), label: "Go to Notes" },
    { keys: "g c", run: go("calendar"), label: "Go to Calendar" },
    { keys: "g w", run: go("canvases"), label: "Go to Canvas" },
    { keys: "g x", run: go("sheets"), label: "Go to Spreadsheets" },
    { keys: "g p", run: go("people"), label: "Go to People" },
    { keys: "g m", run: go("memory"), label: "Go to Memory" },
    { keys: "g v", run: go("voice"), label: "Go to Voice" },
    { keys: "g b", run: go("browser"), label: "Go to the browser" },
    { keys: "g a", run: go("activity"), label: "Go to Jarvis's activity" },
    { keys: "g s", run: go("settings"), label: "Go to Settings" },
    { keys: "g d", run: go("trash"), label: "Go to the trash" },
    { keys: "mod+\\", run: () => layout.split(), inInputs: true, label: "Split pane" },
    { keys: "alt+w", run: () => layout.close(), inInputs: true, label: "Close pane" },
    { keys: "[", run: () => layout.focus(layout.focused() - 1), label: "Pane to the left" },
    { keys: "]", run: () => layout.focus(layout.focused() + 1), label: "Pane to the right" },
    { keys: "?", run: () => setHelp(true), label: "Keyboard shortcuts" },
    {
      keys: "z",
      label: "Undo (while it's offered)",
      when: () => toast.latestAction() !== undefined,
      run: () => {
        const t = toast.latestAction();
        if (!t) return;
        toast.dismiss(t.id);
        t.action?.run();
      },
    },
    {
      keys: "escape",
      run: () => {
        setPalette(false);
        setHelp(false);
      },
      when: () => palette() || help(),
    },
  ]);

  // A pane's position is read when it's used, never kept: panes to its left can close.
  const pane = (entry: Pane) => {
    const index = () => layout.indexOf(entry.key);
    const focusHere = () => {
      if (index() >= 0) layout.focus(index());
    };
    return (
      <section
        class={`relative min-w-0 flex-1 overflow-hidden border-r border-line bg-panel last:border-r-0 ${layout.panes().length > 1 && layout.focused() === index() && !narrow() ? "shadow-[inset_0_2px_0_var(--color-accent)]" : ""}`}
        onMouseDown={focusHere}
        onFocusIn={focusHere}
      >
        <PaneContext.Provider
          value={{
            get close() {
              return layout.panes().length > 1 ? () => layout.close(index()) : null;
            },
          }}
        >
          {/* One broken view takes down its pane, not the app. */}
          <ErrorBoundary fallback={(error, reset) => <PaneCrashed error={error} reset={reset} />}>
            <PaneView route={entry.route} index={index()} />
          </ErrorBoundary>
        </PaneContext.Provider>
      </section>
    );
  };

  return (
    <div class="flex h-full flex-col">
      <div class="flex min-h-0 flex-1">
        <Show
          when={narrow()}
          fallback={<Sidebar onPalette={() => setPalette(true)} onSignOut={props.onSignOut} />}
        >
          <Show when={menu()}>
            <div class="fixed inset-0 z-40 flex" onClick={() => setMenu(false)}>
              {/* Opaque: the page behind mustn't show through the menu's text. */}
              <div
                class="h-full bg-bg pt-[env(safe-area-inset-top)] shadow-2xl"
                role="dialog"
                aria-modal="true"
                aria-label="Menu"
                onClick={(e) => e.stopPropagation()}
              >
                <Sidebar
                  onPalette={() => {
                    setMenu(false);
                    setPalette(true);
                  }}
                  onSignOut={props.onSignOut}
                  onPicked={() => setMenu(false)}
                />
              </div>
              <div class="flex-1 bg-black/30" />
            </div>
          </Show>
        </Show>
        {/* On a phone Jarvis takes the place of the pane. */}
        <main
          class="flex min-w-0 flex-1 pt-[env(safe-area-inset-top)] md:pt-0"
          classList={{ hidden: narrow() && jarvis.open() }}
        >
          <Show when={narrow()} fallback={<For each={layout.entries()}>{pane}</For>}>
            {/* One pane at a time on a phone: the one you're in. */}
            <Show when={layout.entries()[layout.focused()]} keyed>
              {pane}
            </Show>
          </Show>
        </main>
        <Show when={jarvis.open()}>
          <JarvisPane />
        </Show>
      </div>
      <Show when={narrow()}>
        <TabBar waiting={waiting()} onMenu={() => setMenu(true)} />
      </Show>
      <Show when={palette()}>
        <CommandPalette onClose={() => setPalette(false)} />
      </Show>
      <Show when={help()}>
        <Shortcuts onClose={() => setHelp(false)} />
      </Show>
      <Reconnecting />
      <UpdateNotice />
      <div
        class="pointer-events-none fixed bottom-16 left-1/2 z-50 flex w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col items-center gap-2 md:bottom-4"
        role="status"
        aria-live="polite"
      >
        <For each={toast.toasts()}>
          {(t) => (
            <div
              class={`flex items-center gap-3 rounded-lg px-4 py-2 text-sm shadow-lg ${t.tone === "error" ? "bg-bad text-white" : "bg-ink text-bg"}`}
            >
              <span>{t.text}</span>
              <Show when={t.action}>
                {(a) => (
                  <button
                    type="button"
                    class="pointer-events-auto -my-1 min-h-9 shrink-0 rounded px-2 font-semibold underline underline-offset-2 hover:opacity-80"
                    onClick={() => {
                      toast.dismiss(t.id);
                      a().run();
                    }}
                  >
                    {a().label}
                  </button>
                )}
              </Show>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

export function App() {
  const [me, { refetch }] = createResource(getMe);
  setSignedOutHandler(() => {
    live.stop();
    queryClient.clear();
    void refetch();
  });
  // Once Hearth couldn't be reached, that's what shows (retries included) until it answers.
  const [unreachable, setUnreachable] = createSignal(false);
  createEffect(() => {
    if (me.state === "errored") setUnreachable(true);
    else if (me.state === "ready") setUnreachable(false);
  });
  const retryNow = useAutoRetry(
    () => (me.state === "errored" ? "failed" : me.state === "ready" ? "ok" : "trying"),
    () => void refetch(),
  );
  // Read only when there's an answer: an errored resource throws when read.
  const answer = () => (me.state === "ready" || me.state === "refreshing" ? me() : undefined);
  return (
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary fallback={(error, reset) => <Crashed error={error} reset={reset} />}>
        <Switch fallback={<p class="p-6 text-muted">Loading…</p>}>
          <Match when={unreachable()}>
            <Unreachable trying={me.loading} retry={retryNow} />
          </Match>
          <Match when={answer()}>
            {(m) => (
              <Show
                when={m().signedIn}
                fallback={<Login needsSetup={m().needsSetup} onSignedIn={() => void refetch()} />}
              >
                <Shell
                  onSignOut={() => {
                    live.stop();
                    queryClient.clear();
                    forgetAllDocs();
                    void refetch();
                  }}
                />
              </Show>
            )}
          </Match>
        </Switch>
      </ErrorBoundary>
    </QueryClientProvider>
  );
}
