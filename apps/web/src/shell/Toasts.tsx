// The toasts at the bottom of the screen: what just happened ("Moved to the trash · Undo") or what
// didn't. Each carries its tone's icon, so a failure never looks like news. z undoes the newest
// one with an Undo while it shows (App.tsx).

import { For, Show } from "solid-js";
import { Icon } from "../components/icons.tsx";
import { toast } from "../lib/live.ts";

export function Toasts() {
  return (
    <div
      class="pointer-events-none fixed bottom-16 left-1/2 z-50 flex w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col items-center gap-2 md:bottom-4"
      role="status"
      aria-live="polite"
    >
      <For each={toast.toasts()}>
        {(t) => (
          <div
            class={`flex animate-enter items-center gap-2.5 rounded-lg px-4 py-2 text-sm shadow-pop ${t.tone === "error" ? "bg-bad text-on-fill" : "bg-ink text-bg"}`}
          >
            <Icon name={t.tone === "error" ? "bad" : "info"} size={16} class="-ml-1" />
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
  );
}
