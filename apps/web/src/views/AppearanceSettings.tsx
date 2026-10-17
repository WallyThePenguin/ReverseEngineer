// Appearance: this device's theme, one of Nook's six, or the system's choice between Light and
// Dark (the default). It's kept on this device, so a phone and the PC can differ.

import { For } from "solid-js";
import { type ThemeChoice, theme } from "../lib/theme.ts";
import { NOOK_THEMES } from "../styles/themes.ts";

type Colours = (typeof NOOK_THEMES)[number];

/** What each theme is for, beside its name. */
const NOTE: Record<Colours["id"], string> = {
  light: "Bright glass",
  dark: "Dim glass",
  midnight: "True black, for OLED",
  dusk: "Warm charcoal",
  paper: "Cream, for reading",
  contrast: "7:1 text, solid chrome",
};

const OPTIONS: { id: ThemeChoice; name: string; note: string; looks: Colours[] }[] = [
  {
    id: "system",
    name: "Match system",
    note: "Light or Dark, as the system is",
    looks: NOOK_THEMES.filter((t) => t.id === "light" || t.id === "dark"),
  },
  ...NOOK_THEMES.map((t) => ({ id: t.id, name: t.name, note: NOTE[t.id], looks: [t] })),
];

/** A small window in a theme's colours: the canvas, a surface with ink on it, an accent button. */
function Look(props: { colours: Colours }) {
  return (
    <span class="relative block h-16 flex-1" style={{ background: props.colours.canvas }}>
      <span
        class="absolute inset-x-2.5 top-2.5 bottom-0 rounded-t-md px-2 py-1.5"
        style={{ background: props.colours.surface }}
      >
        <span class="block h-1 w-3/5 rounded-full" style={{ background: props.colours.ink }} />
        <span
          class="mt-1 block h-1 w-2/5 rounded-full opacity-50"
          style={{ background: props.colours.ink }}
        />
        <span
          class="mt-2 block h-2.5 w-7 rounded-full"
          style={{ background: props.colours.accent }}
        />
      </span>
    </span>
  );
}

export function AppearanceSettings() {
  return (
    <section class="space-y-2">
      <h2 id="appearance-title" class="font-semibold">
        Appearance
      </h2>
      <p class="text-sm text-muted">
        On this device only, so your phone and your PC can each have their own.
      </p>
      <div
        role="radiogroup"
        aria-labelledby="appearance-title"
        class="grid grid-cols-2 gap-3 sm:grid-cols-4"
      >
        <For each={OPTIONS}>
          {(o) => (
            <label class="cursor-pointer space-y-1.5">
              <input
                type="radio"
                name="theme"
                value={o.id}
                aria-label={o.name}
                aria-describedby={`theme-note-${o.id}`}
                class="peer sr-only"
                checked={theme.choice() === o.id}
                onChange={() => theme.choose(o.id)}
              />
              <span class="flex overflow-hidden rounded-lg border border-line transition-shadow duration-(--duration-fast) peer-checked:border-accent peer-checked:ring-2 peer-checked:ring-accent peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus">
                <For each={o.looks}>{(c) => <Look colours={c} />}</For>
              </span>
              <span class="block text-sm font-medium">{o.name}</span>
              <span id={`theme-note-${o.id}`} class="block text-meta text-muted">
                {o.note}
              </span>
            </label>
          )}
        </For>
      </div>
    </section>
  );
}
