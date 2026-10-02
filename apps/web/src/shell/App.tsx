// The app: sign-in gate, then the shell (sidebar, split panes, Jarvis, Cmd+K).

import { QueryClientProvider } from "@tanstack/solid-query";
import {
  createResource,
  createSignal,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";
import { Login } from "../auth/Login.tsx";
import { Kbd, PaneContext } from "../components/ui.tsx";
import { ChatView } from "../jarvis/Conversation.tsx";
import { JarvisPane, jarvis } from "../jarvis/JarvisPane.tsx";
import { getMe, setSignedOutHandler } from "../lib/api.ts";
import { listHotkeys, useHotkeys } from "../lib/hotkeys.ts";
import { live, queryClient, toast } from "../lib/live.ts";
import { type ListView, layout, type PaneRoute } from "../lib/panes.ts";
import { Activity } from "../views/Activity.tsx";
import { Browser } from "../views/Browser.tsx";
import { Inbox } from "../views/Inbox.tsx";
import { Notes, NoteView } from "../views/Notes.tsx";
import { People } from "../views/People.tsx";
import { RecordView } from "../views/Record.tsx";
import { Settings } from "../views/Settings.tsx";
import { Tasks } from "../views/Tasks.tsx";
import { TaskView } from "../views/TaskView.tsx";
import { CommandPalette } from "./CommandPalette.tsx";
import { Sidebar } from "./Sidebar.tsx";

function PaneView(props: { route: PaneRoute; index: number }) {
  const id = () => ("id" in props.route ? props.route.id : "");
  return (
    <Switch>
      <Match when={props.route.view === "inbox"}>
        <Inbox pane={props.index} />
      </Match>
      <Match when={props.route.view === "tasks"}>
        <Tasks pane={props.index} />
      </Match>
      <Match when={props.route.view === "notes"}>
        <Notes pane={props.index} />
      </Match>
      <Match when={props.route.view === "people"}>
        <People pane={props.index} />
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
  onMount(() => live.start());
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
    { keys: "g t", run: go("tasks"), label: "Go to Tasks" },
    { keys: "g n", run: go("notes"), label: "Go to Notes" },
    { keys: "g p", run: go("people"), label: "Go to People" },
    { keys: "g b", run: go("browser"), label: "Go to the browser" },
    { keys: "g a", run: go("activity"), label: "Go to Jarvis's activity" },
    { keys: "g s", run: go("settings"), label: "Go to Settings" },
    { keys: "mod+\\", run: () => layout.split(), inInputs: true, label: "Split pane" },
    { keys: "alt+w", run: () => layout.close(), inInputs: true, label: "Close pane" },
    { keys: "[", run: () => layout.focus(layout.focused() - 1), label: "Pane to the left" },
    { keys: "]", run: () => layout.focus(layout.focused() + 1), label: "Pane to the right" },
    { keys: "?", run: () => setHelp(true), label: "Keyboard shortcuts" },
    {
      keys: "escape",
      run: () => {
        setPalette(false);
        setHelp(false);
      },
      when: () => palette() || help(),
    },
  ]);

  return (
    <div class="flex h-full">
      <Sidebar onPalette={() => setPalette(true)} onSignOut={props.onSignOut} />
      <main class="flex min-w-0 flex-1">
        <For each={layout.panes()}>
          {(route, i) => (
            <section
              class={`relative min-w-0 flex-1 border-r border-line bg-panel last:border-r-0 ${layout.panes().length > 1 && layout.focused() === i() ? "shadow-[inset_0_2px_0_var(--color-accent)]" : ""}`}
              onMouseDown={() => layout.focus(i())}
              onFocusIn={() => layout.focus(i())}
            >
              <PaneContext.Provider
                value={{
                  get close() {
                    return layout.panes().length > 1 ? () => layout.close(i()) : null;
                  },
                }}
              >
                <PaneView route={route} index={i()} />
              </PaneContext.Provider>
            </section>
          )}
        </For>
      </main>
      <Show when={jarvis.open()}>
        <JarvisPane />
      </Show>
      <Show when={palette()}>
        <CommandPalette onClose={() => setPalette(false)} />
      </Show>
      <Show when={help()}>
        <Shortcuts onClose={() => setHelp(false)} />
      </Show>
      <div class="pointer-events-none fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
        <For each={toast.toasts()}>
          {(t) => (
            <div
              class={`rounded-lg px-4 py-2 text-sm shadow-lg ${t.tone === "error" ? "bg-bad text-white" : "bg-ink text-bg"}`}
            >
              {t.text}
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
  return (
    <QueryClientProvider client={queryClient}>
      <Show
        when={me()}
        fallback={
          <p class="p-6 text-muted">{me.error ? "Can't reach Hearth's server." : "Loading…"}</p>
        }
      >
        {(m) => (
          <Show
            when={m().signedIn}
            fallback={<Login needsSetup={m().needsSetup} onSignedIn={() => void refetch()} />}
          >
            <Shell
              onSignOut={() => {
                live.stop();
                queryClient.clear();
                void refetch();
              }}
            />
          </Show>
        )}
      </Show>
    </QueryClientProvider>
  );
}
