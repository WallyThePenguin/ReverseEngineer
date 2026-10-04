// Checking Jarvis's Chrome (D52): "Test Jarvis's Chrome" runs a few timed steps on a page Hearth
// serves, the way Jarvis would, and the link's recent activity shows what happened between them.

import { createResource, createSignal, For, Show } from "solid-js";
import { Badge, Button } from "../components/ui.tsx";
import { browserLog, type LinkEntry, type SelfTestResult, testChrome } from "../lib/browser.ts";
import { ago } from "../lib/format.ts";

const seconds = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

/** "Test Jarvis's Chrome": each step with how long it took, and what went wrong, if anything. */
export function TestChrome(props: { onDone?: () => void }) {
  const [running, setRunning] = createSignal(false);
  const [result, setResult] = createSignal<SelfTestResult | null>(null);
  const [failed, setFailed] = createSignal<string | null>(null);

  const run = async () => {
    setRunning(true);
    setFailed(null);
    setResult(null);
    try {
      setResult(await testChrome());
    } catch (err) {
      setFailed(err instanceof Error ? err.message : "Couldn't run the test.");
    } finally {
      setRunning(false);
      props.onDone?.();
    }
  };

  return (
    <div class="space-y-2">
      <div class="flex flex-wrap items-center gap-3">
        <Button onClick={() => void run()} disabled={running()}>
          {running() ? "Testing…" : "Test Jarvis's Chrome"}
        </Button>
        <span class="text-sm text-muted">
          {running()
            ? "A test page opens in Jarvis's window for a few seconds."
            : "Opens a test page, reads it, clicks, types and takes a screenshot, as Jarvis would."}
        </span>
      </div>
      <Show when={failed()}>
        <p class="text-sm text-bad">{failed()}</p>
      </Show>
      <Show when={result()}>
        {(r) => (
          <div class="rounded-md border border-line px-3 py-2 text-sm">
            <p class="mb-1 font-medium">
              {r().ok
                ? `Everything worked, in ${seconds(r().totalMs)}.`
                : "Jarvis couldn't finish the test."}
            </p>
            <ul class="space-y-1">
              <For each={r().steps}>
                {(s) => (
                  <li>
                    <div class="flex items-center gap-2">
                      <Badge tone={s.ok ? "ok" : "bad"}>{s.ok ? "Done" : "Failed"}</Badge>
                      <span class="flex-1">{s.label}</span>
                      <span class="font-mono text-xs text-muted">{seconds(s.ms)}</span>
                    </div>
                    <Show when={s.detail}>
                      <p class="pl-2 text-xs text-bad">{s.detail}</p>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </div>
        )}
      </Show>
    </div>
  );
}

const KIND: Record<LinkEntry["kind"], string> = {
  connect: "Connected",
  disconnect: "Disconnected",
  replaced: "Reconnected",
  reject: "Turned away",
  error: "Request failed",
  timeout: "No answer",
};

/** What happened on the link to Chrome lately, and how quickly Chrome answers. */
export function LinkLog(props: { refresh: () => number }) {
  const [log, { refetch }] = createResource(
    () => props.refresh() + 1,
    () => browserLog(),
  );
  return (
    <details class="rounded-md border border-line px-3 py-2 text-sm">
      <summary class="cursor-pointer font-medium" onClick={() => void refetch()}>
        Link activity
      </summary>
      <Show when={log()} fallback={<p class="text-muted">Loading…</p>}>
        {(l) => (
          <div class="mt-2 space-y-2">
            <p class="text-muted">
              {l().stats.calls === 0
                ? "No requests to Chrome since Hearth started."
                : `${l().stats.calls} request(s) to Chrome since Hearth started, ${l().stats.failed} failed. Usually answered in ${seconds(Math.round(l().stats.averageMs ?? 0))}; the slowest took ${seconds(l().stats.slowestMs ?? 0)}.`}
            </p>
            <Show
              when={l().entries.length > 0}
              fallback={<p class="text-muted">Nothing has happened on the link yet.</p>}
            >
              <ul class="max-h-56 space-y-1 overflow-y-auto">
                <For each={l().entries}>
                  {(e) => (
                    <li class="flex gap-2">
                      <span class="w-20 shrink-0 text-xs text-muted">{ago(e.at)}</span>
                      <span class="w-28 shrink-0 font-medium">{KIND[e.kind]}</span>
                      <span class="min-w-0 flex-1 break-words text-muted">
                        {e.message}
                        <Show when={e.method}>
                          <span class="font-mono text-xs">
                            {" "}
                            ({e.method}
                            {e.ms !== undefined ? `, ${seconds(e.ms)}` : ""})
                          </span>
                        </Show>
                      </span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </div>
        )}
      </Show>
    </details>
  );
}
