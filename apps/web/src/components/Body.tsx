// Renders a stored body (markdown plus <m-ref> mentions) as safe DOM, never as HTML.

import { createMemo, For, type JSX, Match, Switch } from "solid-js";
import { blocks, inline } from "../lib/markdown.ts";
import { layout, routeFor } from "../lib/panes.ts";
import { splitInline } from "../lib/text.ts";

/** Bold, italics, `code` and links inside plain text. */
function Rich(props: { text: string }) {
  return (
    <For each={inline(props.text)}>
      {(p) => (
        <Switch fallback={p.text}>
          <Match when={p.kind === "strong"}>
            <strong>{p.text}</strong>
          </Match>
          <Match when={p.kind === "em"}>
            <em>{p.text}</em>
          </Match>
          <Match when={p.kind === "strike"}>
            <s>{p.text}</s>
          </Match>
          <Match when={p.kind === "code"}>
            <code class="rounded bg-sunk px-1 font-mono text-[0.9em]">{p.text}</code>
          </Match>
          <Match when={p.kind === "link" && p}>
            {(l) => (
              <a
                class="text-accent underline"
                href={l().href}
                target="_blank"
                rel="noreferrer noopener"
              >
                {l().text}
              </a>
            )}
          </Match>
        </Switch>
      )}
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

const HEADING = ["", "text-[1.2em]", "text-[1.1em]", "text-[1.05em]"];

export function Body(props: {
  text: string | null;
  class?: string;
  onToggle?: (line: number) => void;
}): JSX.Element {
  // Read again only when the words change: a list that's read again hands rows their text anew,
  // and parsing it afresh would draw every paragraph of every body again.
  const text = createMemo(() => props.text ?? "");
  return (
    <div class={`space-y-1 leading-relaxed ${props.class ?? ""}`}>
      <For each={blocks(text())}>
        {(b) => (
          <Switch>
            <Match when={b.kind === "line" && b}>
              {(l) => (
                <p class="min-h-[1em] whitespace-pre-wrap">
                  {l().text ? <Line text={l().text} /> : null}
                </p>
              )}
            </Match>
            <Match when={b.kind === "heading" && b}>
              {(h) => (
                <p class={`pt-2 font-semibold ${HEADING[h().level] ?? ""}`}>
                  <Line text={h().text} />
                </p>
              )}
            </Match>
            <Match when={b.kind === "check" && b}>
              {(c) => (
                <label class="flex items-start gap-2">
                  <input
                    type="checkbox"
                    class="mt-1 accent-[var(--color-accent)]"
                    aria-label={c().text.replace(/<[^>]+>/g, "")}
                    checked={c().done}
                    disabled={!props.onToggle}
                    onChange={() => props.onToggle?.(c().line)}
                  />
                  <span class={c().done ? "text-muted line-through" : ""}>
                    <Line text={c().text} />
                  </span>
                </label>
              )}
            </Match>
            <Match when={b.kind === "bullet" && b}>
              {(l) => (
                <p class="flex gap-2" style={{ "padding-left": `${0.25 + l().depth * 1.25}rem` }}>
                  <span class="text-muted">•</span>
                  <span>
                    <Line text={l().text} />
                  </span>
                </p>
              )}
            </Match>
            <Match when={b.kind === "number" && b}>
              {(l) => (
                <p class="flex gap-2" style={{ "padding-left": `${0.25 + l().depth * 1.25}rem` }}>
                  <span class="min-w-4 text-right text-muted tabular-nums">{l().n}.</span>
                  <span>
                    <Line text={l().text} />
                  </span>
                </p>
              )}
            </Match>
            <Match when={b.kind === "quote" && b}>
              {(q) => (
                <blockquote class="border-l-2 border-line pl-3 text-muted">
                  <Line text={q().text} />
                </blockquote>
              )}
            </Match>
            <Match when={b.kind === "code" && b}>
              {(c) => (
                <pre class="overflow-x-auto rounded bg-sunk p-2 font-mono text-[0.85em] whitespace-pre">
                  {c().text}
                </pre>
              )}
            </Match>
            <Match when={b.kind === "table" && b}>
              {(t) => (
                <div class="overflow-x-auto">
                  <table class="text-[0.95em]">
                    <thead>
                      <tr>
                        <For each={t().head}>
                          {(h) => (
                            <th class="border-b border-line px-2 py-1 text-left font-semibold">
                              <Line text={h} />
                            </th>
                          )}
                        </For>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={t().rows}>
                        {(row) => (
                          <tr>
                            <For each={row}>
                              {(cell) => (
                                <td class="border-b border-line px-2 py-1 align-top">
                                  <Line text={cell} />
                                </td>
                              )}
                            </For>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              )}
            </Match>
            <Match when={b.kind === "rule"}>
              <hr class="border-line" />
            </Match>
          </Switch>
        )}
      </For>
    </div>
  );
}
