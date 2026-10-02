// Page watches in the app: a watch's status and what changed on its page, the list of all of
// them, and "Watch this page" from the browser.

import { For, Show } from "solid-js";
import { Badge, Button, Empty } from "../components/ui.tsx";
import { ago } from "../lib/format.ts";
import { toast } from "../lib/live.ts";
import { layout } from "../lib/panes.ts";
import { act, useAction } from "../lib/query.ts";
import { lineDiff } from "../lib/text.ts";
import type { PageWatch } from "../lib/types.ts";

const STATUS: Record<PageWatch["status"], { text: string; tone: "ok" | "warn" | "bad" | "muted" }> =
  {
    new: { text: "first check soon", tone: "muted" },
    ok: { text: "watching", tone: "ok" },
    waiting: { text: "waiting for Chrome", tone: "warn" },
    failing: { text: "can't check", tone: "bad" },
  };

function StatusBadge(props: { w: PageWatch }) {
  const s = () =>
    props.w.active ? STATUS[props.w.status] : { text: "paused", tone: "muted" as const };
  return <Badge tone={s().tone}>{s().text}</Badge>;
}

/** Starts watching a page, then shows the new watch beside the current pane. */
export async function watchPage(url: string, title: string) {
  const created = await act<{ id: string }>("page_watch.create", {
    url,
    title: title || undefined,
  });
  if (!created) return;
  toast.show("Watching it. You'll get a notice in the inbox when it changes.");
  layout.open({ view: "record", id: created.id }, { beside: true });
}

/** The watch part of a page watch's record: status, controls, and what changed. */
export function PageWatchPanel(props: { id: string }) {
  const w = useAction<PageWatch>("page_watch.get", () => ({ id: props.id }));
  const changes = () => {
    const d = w.data;
    if (!d?.lastText) return [];
    return d.previousText === null || d.previousText === undefined
      ? []
      : lineDiff(d.previousText, d.lastText);
  };
  return (
    <Show when={w.data}>
      {(d) => (
        <div class="space-y-4">
          <div class="space-y-1 rounded-md bg-sunk px-3 py-3 text-sm">
            <p class="flex flex-wrap items-center gap-2">
              <StatusBadge w={d()} />
              <a
                class="truncate font-mono text-xs text-jarvis underline"
                href={d().url}
                target="_blank"
                rel="noreferrer"
              >
                {d().url}
              </a>
            </p>
            <p class="text-muted">
              Every {d().everyMinutes} minutes,{" "}
              {d().mode === "fetch" ? "fetched without signing in" : "in your Chrome"}
              {d().selector ? `, just ${d().selector}` : ""}.
              {d().lastCheckedAt ? ` Checked ${ago(d().lastCheckedAt ?? "")}.` : ""}
              {d().lastChangedAt ? ` Changed ${ago(d().lastChangedAt ?? "")}.` : ""}
            </p>
            <Show when={d().onChange}>
              <p>
                <span class="text-muted">When it changes, Jarvis will:</span> {d().onChange}
              </p>
            </Show>
            <Show when={d().lastError}>
              <p class="text-bad">{d().lastError}</p>
            </Show>
            <div class="flex gap-2 pt-1">
              <Button small onClick={() => void act("page_watch.check", { id: props.id })}>
                Check now
              </Button>
              <Button
                small
                onClick={() => void act("page_watch.update", { id: props.id, active: !d().active })}
              >
                {d().active ? "Pause" : "Resume"}
              </Button>
              <Button
                small
                kind="danger"
                onClick={async () => {
                  if (await act("entity.trash", { id: props.id })) toast.show("Watch removed.");
                }}
              >
                Remove
              </Button>
            </div>
          </div>
          <Show
            when={changes().length > 0}
            fallback={
              <Show when={d().lastText}>
                <section class="space-y-1">
                  <h2 class="text-sm font-semibold">The page now</h2>
                  <pre class="whitespace-pre-wrap rounded-md border border-line px-3 py-2 text-xs">
                    {d().lastText}
                  </pre>
                </section>
              </Show>
            }
          >
            <section class="space-y-1">
              <h2 class="text-sm font-semibold">What changed</h2>
              <pre class="whitespace-pre-wrap rounded-md border border-line px-3 py-2 text-xs">
                <For each={changes()}>
                  {(c) => (
                    <div
                      class={
                        c.kind === "added"
                          ? "bg-ok/10 text-ok"
                          : c.kind === "removed"
                            ? "text-bad line-through opacity-70"
                            : "text-muted"
                      }
                    >
                      {c.kind === "added" ? "+ " : c.kind === "removed" ? "− " : "  "}
                      {c.text}
                    </div>
                  )}
                </For>
              </pre>
            </section>
          </Show>
        </div>
      )}
    </Show>
  );
}

/** Every page watch, for Settings. */
export function WatchList() {
  const watches = useAction<PageWatch[]>("page_watch.list");
  return (
    <Show
      when={(watches.data ?? []).length > 0}
      fallback={
        <Empty>
          No page watches. Ask Jarvis to watch a page, or use Watch in the Browser pane.
        </Empty>
      }
    >
      <ul class="space-y-1">
        <For each={watches.data}>
          {(w) => (
            <li>
              <button
                type="button"
                class="flex w-full items-center gap-3 rounded-md bg-sunk px-3 py-2 text-left text-sm hover:bg-line/40"
                onClick={(e) => layout.open({ view: "record", id: w.id }, { beside: e.shiftKey })}
              >
                <span class="flex-1 truncate font-medium">{w.title}</span>
                <span class="hidden truncate font-mono text-xs text-muted sm:inline">{w.url}</span>
                <StatusBadge w={w} />
              </button>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}
