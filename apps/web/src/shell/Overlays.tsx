// What opens over the app: the keyboard shortcuts sheet, and the phone's menu drawer. Both keep
// the keyboard inside while open and hand focus back when they close.

import { For } from "solid-js";
import { Kbd } from "../components/ui.tsx";
import { useDialogFocus } from "../lib/focus.ts";
import { listHotkeys } from "../lib/hotkeys.ts";
import { Sidebar } from "./Sidebar.tsx";

export function Shortcuts(props: { onClose: () => void }) {
  let sheet: HTMLDivElement | undefined;
  useDialogFocus(() => sheet);
  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={props.onClose}
    >
      <div
        ref={sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        class="max-h-[80vh] w-[min(520px,92vw)] overflow-auto rounded-xl border border-line bg-panel p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="mb-3 flex items-center">
          <h2 id="shortcuts-title" class="flex-1 font-semibold">
            Keyboard shortcuts
          </h2>
          <button
            type="button"
            class="rounded px-2 text-lg leading-none text-muted hover:bg-sunk hover:text-ink"
            aria-label="Close"
            onClick={props.onClose}
          >
            ×
          </button>
        </div>
        <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <For each={listHotkeys()}>
            {(h) => (
              <>
                <dt>
                  <Kbd>{h.keys}</Kbd>
                </dt>
                <dd class="text-muted">{h.label}</dd>
              </>
            )}
          </For>
        </dl>
      </div>
    </div>
  );
}

/** The phone's menu: the sidebar, sliding over the page, opaque so its text reads. */
export function MenuDrawer(props: {
  onClose: () => void;
  onPalette: () => void;
  onSignOut: () => void;
}) {
  let drawer: HTMLDivElement | undefined;
  useDialogFocus(() => drawer);
  return (
    <div class="fixed inset-0 z-40 flex" onClick={props.onClose}>
      <div
        ref={drawer}
        class="h-full bg-bg pt-[env(safe-area-inset-top)] shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        onClick={(e) => e.stopPropagation()}
      >
        <Sidebar
          onPalette={() => {
            props.onClose();
            props.onPalette();
          }}
          onSignOut={props.onSignOut}
          onPicked={props.onClose}
        />
      </div>
      <div class="flex-1 bg-black/30" />
    </div>
  );
}
