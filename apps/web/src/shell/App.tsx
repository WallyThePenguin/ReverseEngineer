// The app: sign-in gate, then the shell (sidebar, split panes, Jarvis, Cmd+K). A device that was
// signed in last time gets the shell at once, while the server confirms it (lib/signedIn.ts).

import { QueryClientProvider } from "@tanstack/solid-query";
import {
  createEffect,
  createMemo,
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
import { PaneContext } from "../components/ui.tsx";
import { ChatView } from "../jarvis/Conversation.tsx";
import { JarvisPane, jarvis } from "../jarvis/JarvisPane.tsx";
import { getMe, setSignedOutHandler } from "../lib/api.ts";
import { goLabel, PLACES } from "../lib/apps.ts";
import { forgetAllDocs, sendKeptNotes } from "../lib/docStore.ts";
import { pauseHotkeys, useHotkeys } from "../lib/hotkeys.ts";
import { live, queryClient, toast } from "../lib/live.ts";
import { narrow } from "../lib/narrow.ts";
import { type ListView, layout, type Pane, type PaneRoute } from "../lib/panes.ts";
import { rememberSignedIn, showHearth } from "../lib/signedIn.ts";
import { sendKeptOnRestore } from "../lib/trash.ts";
import { Inbox } from "../views/Inbox.tsx";
import { Mail } from "../views/Mail.tsx";
import { MailThreadPane } from "../views/MailThread.tsx";
import { Today } from "../views/Today.tsx";
import { CommandPalette } from "./CommandPalette.tsx";
import {
  Activity,
  Browser,
  Calendar,
  Canvases,
  CanvasView,
  Memory,
  Notes,
  NoteView,
  People,
  RecordView,
  Settings,
  Sheets,
  SheetView,
  Tasks,
  TaskView,
  Trash,
  Voice,
} from "./lazyViews.ts";
import { MenuDrawer, Shortcuts } from "./Overlays.tsx";
import { Sidebar, SidebarRail, sidebar, useWaiting } from "./Sidebar.tsx";
import { Crashed, Notices, PaneCrashed, Unreachable, useAutoRetry } from "./Status.tsx";
import { TabBar } from "./TabBar.tsx";
import { Toasts } from "./Toasts.tsx";

function PaneView(props: { route: PaneRoute; index: number }) {
  const id = () => ("id" in props.route ? props.route.id : "");
  return (
    <Switch>
      <Match when={props.route.view === "today"}>
        <Today pane={props.index} />
      </Match>
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

function Shell(props: { onSignOut: () => void; covered: boolean }) {
  const [palette, setPalette] = createSignal(false);
  const [help, setHelp] = createSignal(false);
  const [menu, setMenu] = createSignal(false);
  const waiting = useWaiting();
  onMount(() => {
    live.start();
    // Note edits a closed tab never sent, and a deleted note's once it's restored (D59).
    void sendKeptNotes();
    onCleanup(sendKeptOnRestore());
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
    ...PLACES.map((p) => ({ keys: p.keys, run: go(p.view), label: goLabel(p) })),
    { keys: "mod+\\", run: () => layout.split(), inInputs: true, label: "Split pane" },
    { keys: "mod+b", run: () => sidebar.toggle(), label: "Show or hide the sidebar" },
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
        setMenu(false);
      },
      when: () => palette() || help() || menu(),
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
        class={`relative min-w-0 flex-1 overflow-hidden border-r border-line bg-panel last:border-r-0 md:min-w-80 ${layout.panes().length > 1 && layout.focused() === index() && !narrow() ? "shadow-[inset_0_2px_0_var(--color-accent)]" : ""}`}
        onMouseDown={focusHere}
        onFocusIn={focusHere}
      >
        <PaneContext.Provider
          value={{
            get close() {
              return layout.panes().length > 1 ? () => layout.close(index()) : null;
            },
            get view() {
              return entry.route.view;
            },
            get index() {
              return index();
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
    // Covered while Hearth can't be reached: kept as it is, out of reach of clicks and typing.
    <div class="flex h-full flex-col" inert={props.covered}>
      <div class="flex min-h-0 flex-1">
        <Show
          when={narrow()}
          fallback={
            <Show when={!sidebar.hidden()} fallback={<SidebarRail />}>
              <Sidebar onPalette={() => setPalette(true)} onSignOut={props.onSignOut} />
            </Show>
          }
        >
          <Show when={menu()}>
            <MenuDrawer
              onClose={() => setMenu(false)}
              onPalette={() => setPalette(true)}
              onSignOut={props.onSignOut}
            />
          </Show>
        </Show>
        {/* On a phone Jarvis takes the place of the pane. */}
        <main
          class="flex min-w-0 flex-1 pt-[env(safe-area-inset-top)] md:overflow-x-auto md:pt-0"
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
      <Notices />
      <Toasts />
    </div>
  );
}

export function App() {
  const [me, { refetch }] = createResource(getMe);
  setSignedOutHandler(() => {
    rememberSignedIn(false);
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
  createEffect(() => pauseHotkeys(unreachable()));
  const retryNow = useAutoRetry(
    () => (me.state === "errored" ? "failed" : me.state === "ready" ? "ok" : "trying"),
    () => void refetch(),
  );
  // Read only when there's an answer: an errored resource throws when read.
  const answer = () => (me.state === "ready" || me.state === "refreshing" ? me() : undefined);
  createEffect(() => {
    const a = answer();
    if (a) rememberSignedIn(a.signedIn);
  });
  // One condition from the guess to the answer, so the shell isn't drawn twice when they agree.
  const hearth = createMemo(() => showHearth(answer()));
  return (
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary fallback={(error, reset) => <Crashed error={error} reset={reset} />}>
        <Switch fallback={<p class="p-6 text-muted">Loading…</p>}>
          <Match when={hearth()}>
            <Shell
              covered={unreachable()}
              onSignOut={() => {
                rememberSignedIn(false);
                live.stop();
                queryClient.clear();
                forgetAllDocs();
                void refetch();
              }}
            />
            {/* Over the guess, not instead of it: what you'd started typing is there after.
                Above z-50, where an open menu's portal sits outside the shell. */}
            <Show when={unreachable()}>
              <div class="fixed inset-0 z-[60] bg-bg">
                <Unreachable trying={me.loading} retry={retryNow} />
              </div>
            </Show>
          </Match>
          <Match when={unreachable()}>
            <Unreachable trying={me.loading} retry={retryNow} />
          </Match>
          <Match when={answer()}>
            {(m) => <Login needsSetup={m().needsSetup} onSignedIn={() => void refetch()} />}
          </Match>
        </Switch>
      </ErrorBoundary>
    </QueryClientProvider>
  );
}
