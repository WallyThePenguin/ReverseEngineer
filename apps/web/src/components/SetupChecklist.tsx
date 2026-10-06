// "Set up Hearth": on Today and an empty Updates list, what's still to connect, each with a link to its Settings
// section. It goes away once everything's done, or when you hide it.

import { createSignal, createUniqueId, For, Show } from "solid-js";
import { useAction } from "../lib/query.ts";
import { openSettings } from "../lib/settingsNav.ts";
import { setupSteps } from "../lib/setup.ts";
import type { SystemStatus } from "../lib/types.ts";
import { Icon } from "./icons.tsx";
import { Button } from "./ui.tsx";

const HIDDEN_KEY = "hearth.setupHidden";

function wasHidden(): boolean {
  try {
    return localStorage.getItem(HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function SetupChecklist(props: { pane: number; class?: string }) {
  const status = useAction<SystemStatus>("system.status");
  const [hidden, setHidden] = createSignal(wasHidden());
  const title = createUniqueId();
  const steps = () => setupSteps(status.data, status.dataUpdatedAt);
  const finished = () => steps().filter((s) => s.done).length;
  const hide = () => {
    setHidden(true);
    try {
      localStorage.setItem(HIDDEN_KEY, "1");
    } catch {}
  };

  return (
    <Show when={!hidden() && steps().length > 0 && finished() < steps().length}>
      <section
        aria-labelledby={title}
        class={`${props.class ?? "mx-4 mt-4"} rounded-lg border border-line bg-panel p-4`}
      >
        <div class="flex items-center gap-3">
          <h2 id={title} class="flex-1 text-heading">
            Set up Hearth
          </h2>
          <span class="text-meta text-muted tabular-nums">
            {finished()} of {steps().length} done
          </span>
          <Button small onClick={hide} title="Hide this list on this device">
            Hide
          </Button>
        </div>
        {/* The words beside it say the same, so it's only for the eye. */}
        <div aria-hidden="true" class="mt-3 h-1.5 overflow-hidden rounded-full bg-sunk">
          <div
            class="h-full rounded-full bg-ok transition-[width] duration-(--duration-slow) ease-out"
            style={{ width: `${(finished() / steps().length) * 100}%` }}
          />
        </div>
        <ul class="mt-3 divide-y divide-line">
          <For each={steps()}>
            {(step) => (
              <li class="flex items-center gap-3 py-2">
                <Icon
                  name={step.done ? "circle-check" : "circle"}
                  size={18}
                  class={step.done ? "text-ok" : "text-faint"}
                />
                <div class="min-w-0 flex-1">
                  <p class={`text-sm ${step.done ? "text-muted" : ""}`}>
                    <span class="sr-only">{step.done ? "Done: " : "To do: "}</span>
                    {step.label}
                  </p>
                  <Show when={!step.done && step.detail}>
                    <p class="text-xs text-muted">{step.detail}</p>
                  </Show>
                </div>
                <Show when={!step.done}>
                  <Button small onClick={() => openSettings(step.section, props.pane)}>
                    {step.id === "jarvis" || step.id === "backup" ? "See how" : "Set up"}
                  </Button>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </section>
    </Show>
  );
}
