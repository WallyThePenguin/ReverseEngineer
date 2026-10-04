// Settings for Jarvis's browser: pair the Hearth extension in your Chrome, test it, and the sites
// Jarvis may act on without asking or never opens (D24, D25, D52).

import { createResource, createSignal, onCleanup, Show } from "solid-js";
import { Badge, Button } from "../components/ui.tsx";
import { browserStatus, openChrome, pairBrowser, unpairBrowser } from "../lib/browser.ts";
import { ago } from "../lib/format.ts";
import { reportError, toast } from "../lib/live.ts";
import { act, useAction } from "../lib/query.ts";
import { LinkLog, TestChrome } from "./ChromeCheck.tsx";
import { WatchList } from "./PageWatch.tsx";

interface SiteRules {
  allowed: string[];
  blocked: string[];
}

const lines = (text: string) =>
  text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);

function Pairing() {
  const [status, { refetch }] = createResource(browserStatus);
  const [code, setCode] = createSignal<string | null>(null);
  const timer = setInterval(() => void refetch(), 5000);
  onCleanup(() => clearInterval(timer));

  const [opening, setOpening] = createSignal(false);
  const open = async () => {
    setOpening(true);
    try {
      await openChrome();
      toast.show("Chrome is open and connected.");
    } catch (err) {
      reportError(err);
    } finally {
      setOpening(false);
      void refetch();
    }
  };

  const pair = async () => {
    try {
      setCode(await pairBrowser());
      void refetch();
    } catch (err) {
      reportError(err);
    }
  };

  return (
    <div class="space-y-2">
      <div class="flex items-center gap-3 rounded-md bg-sunk px-3 py-3">
        <div class="flex-1">
          <Show when={status()} fallback={<p class="text-sm text-muted">Checking…</p>}>
            {(s) => (
              <>
                <p class="flex items-center gap-2 font-medium">
                  {s().connected
                    ? "Connected"
                    : s().paired
                      ? "Paired, not connected"
                      : "Not paired"}
                  <Show when={s().connected}>
                    <Badge tone="ok">extension {s().version}</Badge>
                  </Show>
                </p>
                <p class="text-sm text-muted">
                  {s().connected
                    ? `Since ${ago(s().since ?? "")}. Jarvis has ${s().tabs.length} tab(s) it may use.`
                    : !s().paired
                      ? "Install the Hearth extension in Chrome, then pair it here."
                      : s().opening
                        ? "Opening Chrome on the PC…"
                        : s().canOpen
                          ? "Chrome is closed. Hearth opens it when Jarvis needs it."
                          : "Open Chrome on the PC; the extension connects by itself."}
                </p>
                <Show when={!s().connected && !s().opening && s().openError}>
                  <p class="text-sm text-bad">{s().openError}</p>
                </Show>
                <Show when={s().connected && s().problem}>
                  <p class="text-sm text-warn">{s().problem}</p>
                </Show>
              </>
            )}
          </Show>
        </div>
        <Show when={status()?.paired && !status()?.connected && status()?.canOpen}>
          <Button disabled={opening()} onClick={() => void open()}>
            Open Chrome
          </Button>
        </Show>
        <Show when={status()?.paired}>
          <Button
            kind="danger"
            onClick={async () => {
              await unpairBrowser();
              setCode(null);
              void refetch();
              toast.show("Chrome is unpaired. Jarvis can't use it until you pair again.");
            }}
          >
            Unpair
          </Button>
        </Show>
        <Button kind="primary" onClick={() => void pair()}>
          {status()?.paired ? "Pair again" : "Pair Chrome"}
        </Button>
      </div>
      <Show when={code()}>
        {(c) => (
          <div class="space-y-2 rounded-md border border-line px-3 py-3 text-sm">
            <p>
              In Chrome, open the Hearth extension's options. Enter this address and code, then
              save. The code is shown only once.
            </p>
            <p>
              Address: <code class="font-mono">{location.origin}</code>
            </p>
            <div class="flex items-center gap-2">
              <code class="flex-1 truncate rounded bg-sunk px-2 py-1 font-mono text-xs">{c()}</code>
              <Button
                small
                onClick={() => {
                  void navigator.clipboard.writeText(c());
                  toast.show("Code copied.");
                }}
              >
                Copy
              </Button>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}

function Sites() {
  const rules = useAction<SiteRules>("browser.sites");
  const [allowed, setAllowed] = createSignal<string | null>(null);
  const [blocked, setBlocked] = createSignal<string | null>(null);
  const shown = (draft: string | null, list: string[] | undefined) =>
    draft ?? (list ?? []).join("\n");

  const save = async () => {
    const next = {
      allowed: lines(shown(allowed(), rules.data?.allowed)),
      blocked: lines(shown(blocked(), rules.data?.blocked)),
    };
    if (await act("browser.set_sites", next)) {
      setAllowed(null);
      setBlocked(null);
      toast.show("Sites saved.");
    }
  };

  return (
    <div class="grid gap-3 sm:grid-cols-2">
      <label class="space-y-1 text-sm">
        <span class="font-medium">Trusted sites: Jarvis can act here without asking</span>
        <span class="block text-muted">
          Jarvis opens these and clicks, types and sends on them without asking first, even after
          reading an email or a web page. Payments, passwords and security settings, sending money
          and deleting your account still always need your yes. Subdomains are included.
        </span>
        <textarea
          class="h-28 w-full rounded-md border border-line bg-panel px-2 py-1 font-mono text-xs"
          value={shown(allowed(), rules.data?.allowed)}
          placeholder={"docs.example.org\nwikipedia.org"}
          onInput={(e) => setAllowed(e.currentTarget.value)}
        />
      </label>
      <label class="space-y-1 text-sm">
        <span class="font-medium">Never open</span>
        <span class="block text-muted">
          Jarvis never opens or reads these. Add your bank. Subdomains are included.
        </span>
        <textarea
          class="h-28 w-full rounded-md border border-line bg-panel px-2 py-1 font-mono text-xs"
          value={shown(blocked(), rules.data?.blocked)}
          onInput={(e) => setBlocked(e.currentTarget.value)}
        />
      </label>
      <div class="sm:col-span-2">
        <Button onClick={() => void save()} disabled={allowed() === null && blocked() === null}>
          Save sites
        </Button>
      </div>
    </div>
  );
}

export function ChromeSettings() {
  // Running the test refreshes the link's activity.
  const [refresh, setRefresh] = createSignal(0);
  return (
    <section class="space-y-3">
      <h2 class="font-semibold">Chrome</h2>
      <p class="text-sm text-muted">
        Jarvis uses your own Chrome, signed in as you, in its own window and in tabs you hand it.
        Watch it, or take over, in the Browser pane.
      </p>
      <Pairing />
      <TestChrome onDone={() => setRefresh((n) => n + 1)} />
      <LinkLog refresh={refresh} />
      <Sites />
      <h3 class="pt-2 font-medium">Page watches</h3>
      <WatchList />
    </section>
  );
}
