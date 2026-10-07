// Settings for Hearth's Windows app: Hearth in its own window, Windows notifications, dictation,
// voice commands and talking to Jarvis. "Connect Hearth on this PC" signs it in from this browser
// (D53); pairing with a code still works too. Its token runs only the few actions it needs.

import { createQuery } from "@tanstack/solid-query";
import { createSignal, Show } from "solid-js";
import { QueryView } from "../components/QueryView.tsx";
import { Button } from "../components/ui.tsx";
import { request } from "../lib/api.ts";
import { inDesktopApp } from "../lib/desktop.ts";
import { ago } from "../lib/format.ts";
import { queryClient, reportError, toast } from "../lib/live.ts";
import { windowAsked } from "../lib/settingsNav.ts";

interface Device {
  name: string;
  pairedAt: string;
  lastSeenAt: string | null;
}

/** Asks Hearth for a one-minute connect link, and opens it: Windows hands it to the app. */
async function connectThisPc(): Promise<boolean> {
  const unreachable = "Couldn't reach Hearth. Try again in a moment.";
  const res = await fetch("/api/auth/desktop/handoff", {
    method: "POST",
    credentials: "same-origin",
  }).catch(() => null);
  if (!res) throw new Error(unreachable);
  const body = (await res.json().catch(() => ({}))) as { link?: string; error?: string };
  if (!res.ok || !body.link?.startsWith("hearth://connect?nonce=")) {
    throw new Error(body.error ?? unreachable);
  }
  location.href = body.link;
  return true;
}

export function DesktopSettings() {
  const devices = createQuery(() => ({
    queryKey: ["devices"],
    queryFn: () => request<{ devices: Device[] }>("/api/devices").then((b) => b.devices),
  }));
  const [code, setCode] = createSignal<string | null>(null);
  const [asked, setAsked] = createSignal(false);
  // The set-up checklist counts a connected desktop app too.
  const refresh = () => {
    void devices.refetch();
    void queryClient.invalidateQueries({ queryKey: ["system.status"] });
  };

  const connect = async () => {
    try {
      windowAsked.set(false);
      setAsked(await connectThisPc());
      // The app pairs itself again; show it once it has.
      window.setTimeout(refresh, 15_000);
    } catch (err) {
      reportError(err);
    }
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
        Hearth for Windows: Hearth in its own window, notifications, dictation into any app, and
        Jarvis a hotkey away. Install it on your PC, then connect it here.
      </p>
      {/* Its sign-in page sent you here (D69). Connecting is still your click. */}
      <Show when={windowAsked.get()}>
        <p class="rounded-md bg-accent-soft px-3 py-2 text-sm">
          Hearth's window on this PC asked to be signed in again. Choose Connect Hearth on this PC.
        </p>
      </Show>
      <QueryView query={devices} what="the desktop app's connection">
        {(list) => {
          const desktop = () => list().find((d) => d.name === "desktop");
          return (
            <div class="flex items-center gap-3 rounded-md bg-sunk px-3 py-3">
              <div class="flex-1">
                <p class="font-medium">{desktop() ? "Connected" : "Not connected"}</p>
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
                  Disconnect
                </Button>
              </Show>
              <Button kind="primary" onClick={() => void connect()}>
                Connect Hearth on this PC
              </Button>
            </div>
          );
        }}
      </QueryView>
      <Show when={asked()}>
        <p class="text-sm text-muted">
          {inDesktopApp()
            ? "Choose Connect in the box that opens."
            : "If your browser asks to open Hearth, allow it, then choose Connect in Hearth's box. Nothing happening? Make sure the app is installed and running, and try again: the link lasts a minute."}
        </p>
      </Show>

      <details class="text-sm">
        <summary class="cursor-pointer text-muted">Pair with a code instead</summary>
        <div class="mt-2 space-y-2">
          <Button onClick={() => void pair()}>Make a pairing code</Button>
          <Show when={code()}>
            {(c) => (
              <div class="space-y-2 rounded-md border border-line px-3 py-3">
                <p>
                  In the desktop app's voice settings, under Hearth, enter this address and code.
                  The code is shown only once.
                </p>
                <p>
                  Address: <code class="font-mono">{location.origin}</code>
                </p>
                <div class="flex items-center gap-2">
                  <code class="flex-1 truncate rounded bg-sunk px-2 py-1 font-mono text-xs">
                    {c()}
                  </code>
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
      </details>
    </section>
  );
}
