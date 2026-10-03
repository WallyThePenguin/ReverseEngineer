// Settings for the desktop app (dictation, voice commands, talking to Jarvis): pair it with a
// code that lets it run only those few actions.

import { createResource, createSignal, Show } from "solid-js";
import { Button } from "../components/ui.tsx";
import { ago } from "../lib/format.ts";
import { reportError, toast } from "../lib/live.ts";

interface Device {
  name: string;
  pairedAt: string;
  lastSeenAt: string | null;
}

async function call<T>(path: string, method = "GET"): Promise<T> {
  const res = await fetch(`/api/devices${path}`, { method, credentials: "same-origin" });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? "Couldn't reach Hearth.");
  return body;
}

export function DesktopSettings() {
  const [devices, { refetch }] = createResource(() =>
    call<{ devices: Device[] }>("").then((b) => b.devices),
  );
  const desktop = () => devices()?.find((d) => d.name === "desktop");
  const [code, setCode] = createSignal<string | null>(null);

  const pair = async () => {
    try {
      setCode((await call<{ token: string }>("/desktop/pair", "POST")).token);
      void refetch();
    } catch (err) {
      reportError(err);
    }
  };
  const unpair = async () => {
    try {
      await call("/desktop", "DELETE");
      setCode(null);
      void refetch();
      toast.show("The desktop app is signed out.");
    } catch (err) {
      reportError(err);
    }
  };

  return (
    <section class="space-y-3">
      <h2 class="font-semibold">Desktop app</h2>
      <p class="text-sm text-muted">
        Dictate into any app, speak commands about selected text, and talk to Jarvis. Its code lets
        it do only that.
      </p>
      <div class="flex items-center gap-3 rounded-md bg-sunk px-3 py-3">
        <div class="flex-1">
          <p class="font-medium">{desktop() ? "Paired" : "Not paired"}</p>
          <Show when={desktop()}>
            {(d) => (
              <p class="text-sm text-muted">
                {d().lastSeenAt ? `Last used ${ago(d().lastSeenAt!)}.` : "Not used yet."}
              </p>
            )}
          </Show>
        </div>
        <Show when={desktop()}>
          <Button kind="danger" onClick={() => void unpair()}>
            Unpair
          </Button>
        </Show>
        <Button kind="primary" onClick={() => void pair()}>
          {desktop() ? "Pair again" : "Pair the desktop app"}
        </Button>
      </div>
      <Show when={code()}>
        {(c) => (
          <div class="space-y-2 rounded-md border border-line px-3 py-3 text-sm">
            <p>
              In the desktop app's settings, under Hearth, enter this address and code. The code is
              shown only once.
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
    </section>
  );
}
