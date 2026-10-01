// Renders a stored body (light markdown plus <m-ref> mentions) as safe DOM, never as HTML.

import { For, type JSX, Match, Switch } from "solid-js";
import { layout, routeFor } from "../lib/panes.ts";
import { splitInline } from "../lib/text.ts";

/** **bold**, `code` and bare links inside plain text. */
function Rich(props: { text: string }) {
  const parts = () =>
    props.text.split(/(\*\*[^*]+\*\*|`[^`]+`|https?:\/\/[^\s)]+)/g).filter(Boolean);
  return (
    <For each={parts()}>
      {(p) =>
        p.startsWith("**") && p.endsWith("**") && p.length > 4 ? (
          <strong>{p.slice(2, -2)}</strong>
        ) : p.startsWith("`") && p.endsWith("`") && p.length > 2 ? (
          <code class="rounded bg-sunk px-1 font-mono text-[0.9em]">{p.slice(1, -1)}</code>
        ) : /^https?:\/\//.test(p) ? (
          <a class="text-accent underline" href={p} target="_blank" rel="noreferrer noopener">
            {p}
          </a>
        ) : (
          p
        )
      }
    </For>
  );
}

export function Mention(props: { type: string; id: string; label: string }) {
  return (
    <button
      type="button"
      class="mention"
      data-type={props.type}
      title={`Open ${props.label} (shift-click opens beside)`}
      onClick={(e) => layout.open(routeFor(props.type, props.id), { beside: e.shiftKey })}
    >
      @{props.label}
    </button>
  );
}

function Line(props: { text: string }) {
  return (
    <For each={splitInline(props.text)}>
      {(part) =>
        part.kind === "mention" ? (
          <Mention type={part.type} id={part.id} label={part.label} />
        ) : (
          <Rich text={part.text} />
        )
      }
    </For>
  );
}

export function Body(props: {
  text: string | null;
  class?: string;
  onToggle?: (line: number) => void;
}): JSX.Element {
  const lines = () => (props.text ?? "").split("\n");
  return (
    <div class={`space-y-1 leading-relaxed ${props.class ?? ""}`}>
      <For each={lines()}>
        {(line, i) => (
          <Switch
            fallback={
              <p class="min-h-[1em] whitespace-pre-wrap">{line ? <Line text={line} /> : null}</p>
            }
          >
            <Match when={/^#{1,3} /.test(line)}>
              <p class="pt-2 text-[1.05em] font-semibold">
                <Line text={line.replace(/^#{1,3} /, "")} />
              </p>
            </Match>
            <Match when={/^\s*[-*] \[( |x|X)\] /.test(line)}>
              <label class="flex items-start gap-2">
                <input
                  type="checkbox"
                  class="mt-1 accent-[var(--color-accent)]"
                  checked={/\[(x|X)\]/.test(line)}
                  disabled={!props.onToggle}
                  onChange={() => props.onToggle?.(i())}
                />
                <span class={/\[(x|X)\]/.test(line) ? "text-muted line-through" : ""}>
                  <Line text={line.replace(/^\s*[-*] \[( |x|X)\] /, "")} />
                </span>
              </label>
            </Match>
            <Match when={/^\s*[-*] /.test(line)}>
              <p class="flex gap-2 pl-1">
                <span class="text-faint">•</span>
                <span>
                  <Line text={line.replace(/^\s*[-*] /, "")} />
                </span>
              </p>
            </Match>
          </Switch>
        )}
      </For>
    </div>
  );
}
