// A pane's header: its title, what you can do there, a "more" menu and the pane's close button.
// components/ui.tsx re-exports all of this, so it's imported from there as it always was.

import type { JSX } from "solid-js";
import { createContext, Show, useContext } from "solid-js";
import { listFor } from "../lib/apps.ts";
import { layout } from "../lib/panes.ts";
import { moveToTrash, restore, TRASHABLE } from "../lib/trash.ts";
import { Button } from "./kit/Button.tsx";
import { IconButton } from "./kit/IconButton.tsx";
import { Notice } from "./kit/Notice.tsx";
import { type MenuItem, Overflow } from "./Menu.tsx";

/** The record a pane shows, so its header can offer to move it to the trash. */
export interface PaneRecord {
  id: string;
  type: string;
  /** It's in the trash (some records still open from there): the header offers Restore. */
  trashed?: boolean;
}

/** Which pane a view is in, how to close it (when there's more than one), and its record. */
export const PaneContext = createContext<{
  close: (() => void) | null;
  record?: PaneRecord | undefined;
}>({ close: null });

/** Tells the pane's header which record is showing (the header can be drawn by an editor). */
export function ForRecord(props: { record: PaneRecord | undefined; children: JSX.Element }) {
  const pane = useContext(PaneContext);
  return (
    <PaneContext.Provider
      value={{
        get close() {
          return pane.close;
        },
        get record() {
          return props.record;
        },
      }}
    >
      {props.children}
    </PaneContext.Provider>
  );
}

export function PaneHeader(props: {
  title: JSX.Element;
  children?: JSX.Element;
  sub?: JSX.Element;
  /** More actions, behind a "more" button. */
  menu?: MenuItem[];
  /** The record this pane shows: the menu offers to move it to the trash. */
  record?: PaneRecord | undefined;
}) {
  const pane = useContext(PaneContext);
  const record = () => {
    const r = props.record ?? pane.record;
    return r && TRASHABLE.has(r.type) ? r : undefined;
  };
  const items = (): MenuItem[] => {
    const r = record();
    if (!r) return props.menu ?? [];
    if (r.trashed) return [{ label: "Restore", run: () => void restore(r.id) }];
    return [
      ...(props.menu ?? []),
      {
        label: "Move to trash",
        danger: true,
        run: async () => {
          if (!(await moveToTrash(r.id))) return;
          // A lone pane can't close: it goes to the list the record was in, or the inbox.
          if (pane.close) pane.close();
          else layout.open({ view: listFor(r.type) ?? "inbox" });
        },
      },
    ];
  };
  return (
    <>
      <header class="flex min-h-12 items-start gap-2 border-b border-line px-4 py-2">
        <div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
          <div class="min-w-24 flex-1">
            {/* A long title wraps to a second line before it's cut short: a pane beside another,
                or a phone, has room for a few words a line. */}
            <h1 class="line-clamp-2 text-title break-words">{props.title}</h1>
            <Show when={props.sub}>
              {(sub) => <p class="truncate text-meta text-muted">{sub()}</p>}
            </Show>
          </div>
          {props.children}
        </div>
        <Show when={items().length > 0}>
          <Overflow items={items()} label="More actions" />
        </Show>
        <Show when={pane.close}>
          <IconButton
            icon="x"
            label="Close pane"
            title="Close pane (Alt+W)"
            class="-mr-2"
            onClick={(e) => {
              e.stopPropagation();
              pane.close?.();
            }}
          />
        </Show>
      </header>
      <Show when={record()?.trashed && record()}>
        {(r) => (
          <Notice
            strip
            icon="trash-2"
            action={
              <Button small onClick={() => void restore(r().id)}>
                Restore
              </Button>
            }
          >
            This is in the trash.
          </Notice>
        )}
      </Show>
    </>
  );
}
