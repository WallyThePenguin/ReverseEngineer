// Settings for the desktop app (dictation, voice commands, talking to Jarvis): pair it with a
// code that lets it run only those few actions.

import { createQuery } from "@tanstack/solid-query";
import { createSignal, Show } from "solid-js";
import { QueryView } from "../components/QueryView.tsx";
import { Button } from "../components/ui.tsx";
import { request } from "../lib/api.ts";
import { ago } from "../lib/format.ts";
import { queryClient, reportError, toast } from "../lib/live.ts";

interface Device {
  name: string;
  pairedAt: string;
  lastSeenAt: string | null;
}

export function DesktopSettings() {
  const devices = createQuery(() => ({
    queryKey: ["devices"],
    queryFn: () => request<{ devices: Device[] }>("/api/devices").then((b) => b.devices),
  }));
  const [code, setCode] = createSignal<string | null>(null);
  // The set-up checklist counts a paired desktop app too.
  const refresh = () => {
    void devices.refetch();
    void queryClient.invalidateQueries({ queryKey: ["system.status"] });
  };

  const pair = async () => {
    try {
      setCode((await request<{ token: string }>("/api/devices/desktop/pair", "POST")).token);
      refresh();
    } catch (err) {
      reportError(err);
    }
  };
  const unpair = async () => {
    try {
      await request("/api/devices/desktop", "DELETE");
      setCode(null);
      refresh();
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
      <QueryView query={devices} what="the desktop app's pairing">
        {(list) => {
          const desktop = () => list().find((d) => d.name === "desktop");
          return (
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
          );
        }}
      </QueryView>
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
