// Settings' table of contents: a strip of section names that jumps to each one and shows which
// one you're reading. A link from elsewhere (the set-up checklist) lands on its section too.

import { createEffect, createSignal, For, type JSX, onCleanup, onMount } from "solid-js";
import { SETTINGS_SECTIONS, type SettingsSection, settingsTarget } from "../lib/settingsNav.ts";

/** One section of Settings, where the strip can jump to. */
export function Anchor(props: { id: SettingsSection; children: JSX.Element }) {
  return (
    <div data-section={props.id} class="scroll-mt-20">
      {props.children}
    </div>
  );
}

export function SettingsNav(props: { root: () => HTMLElement | undefined }) {
  const [active, setActive] = createSignal<SettingsSection>(SETTINGS_SECTIONS[0].id);
  const find = (id: SettingsSection) =>
    props.root()?.querySelector<HTMLElement>(`[data-section="${id}"]`) ?? null;
  // While a jump settles, its own scrolling doesn't move the mark (it would flick through the
  // sections passed, and land on the wrong one when the section can't reach the top). Sections
  // above can still be loading and push it down, so it's put back in place twice; scrolling
  // yourself ends the jump.
  let jumping: SettingsSection | null = null;
  const settles: number[] = [];
  const endJump = () => {
    jumping = null;
    for (const t of settles.splice(0)) window.clearTimeout(t);
  };
  onCleanup(endJump);
  const go = (id: SettingsSection, smooth: boolean) => {
    endJump();
    jumping = id;
    find(id)?.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "auto" });
    setActive(id);
    for (const ms of [700, 1600])
      settles.push(
        window.setTimeout(() => {
          if (jumping !== id) return;
          find(id)?.scrollIntoView({ block: "start" });
          if (ms === 1600) jumping = null;
        }, ms),
      );
  };

  onMount(() => {
    const root = props.root();
    if (!root) return;
    for (const kind of ["wheel", "touchmove", "keydown", "pointerdown"] as const)
      root.addEventListener(kind, endJump, { passive: true });
    // The section you're reading is the last one whose top has passed under the strip.
    const spy = () => {
      if (jumping) return;
      const line = root.getBoundingClientRect().top + 96;
      let current: SettingsSection = SETTINGS_SECTIONS[0].id;
      for (const s of SETTINGS_SECTIONS) {
        const el = find(s.id);
        if (el && el.getBoundingClientRect().top <= line) current = s.id;
      }
      // At the very bottom, the last sections can't reach the strip; the last one is showing.
      if (root.scrollTop > 0 && root.scrollTop + root.clientHeight >= root.scrollHeight - 2)
        current = SETTINGS_SECTIONS[SETTINGS_SECTIONS.length - 1]!.id;
      setActive(current);
    };
    root.addEventListener("scroll", spy, { passive: true });
    onCleanup(() => {
      root.removeEventListener("scroll", spy);
      for (const kind of ["wheel", "touchmove", "keydown", "pointerdown"] as const)
        root.removeEventListener(kind, endJump);
    });
  });

  // A link from elsewhere asked for a section: go there once this pane has laid out.
  createEffect(() => {
    const wanted = settingsTarget.get();
    if (!wanted) return;
    settingsTarget.set(null);
    requestAnimationFrame(() => go(wanted, false));
  });

  // The strip scrolls sideways in a narrow pane: keep the current name in view.
  let strip: HTMLElement | undefined;
  const chips = new Map<SettingsSection, HTMLButtonElement>();
  createEffect(() => {
    const chip = chips.get(active());
    if (!strip || !chip) return;
    // The strip is sticky, so it is its chips' offset parent.
    const left = chip.offsetLeft;
    if (left < strip.scrollLeft || left + chip.offsetWidth > strip.scrollLeft + strip.clientWidth)
      strip.scrollLeft = left - (strip.clientWidth - chip.offsetWidth) / 2;
  });

  return (
    <nav
      ref={strip}
      aria-label="Settings sections"
      // It sticks over the pane's top padding too, so nothing shows above it.
      class="sticky -top-4 z-10 -mx-5 -mt-4 flex gap-1 overflow-x-auto [scrollbar-width:thin] border-b border-line bg-panel px-4 py-2"
    >
      <For each={SETTINGS_SECTIONS}>
        {(s) => (
          <button
            ref={(el) => chips.set(s.id, el)}
            type="button"
            class={`min-h-11 shrink-0 rounded-md px-2.5 text-sm whitespace-nowrap md:min-h-0 md:py-1 ${active() === s.id ? "bg-sunk font-medium text-ink" : "text-muted hover:text-ink"}`}
            aria-current={active() === s.id ? "true" : undefined}
            onClick={() => go(s.id, true)}
          >
            {s.label}
          </button>
        )}
      </For>
    </nav>
  );
}
