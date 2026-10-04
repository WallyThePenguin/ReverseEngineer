// Settings for Hearth's Windows app: Hearth in its own window, Windows notifications, dictation,
// voice commands and talking to Jarvis. "Connect Hearth on this PC" signs it in from this browser
// (D53); pairing with a code still works too. Its token runs only the few actions it needs.

import { createResource, createSignal, Show } from "solid-js";
import { Button } from "../components/ui.tsx";
import { inDesktopApp } from "../lib/desktop.ts";
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

/** Asks Hearth for a one-minute connect link, and opens it: Windows hands it to the app. */
async function connectThisPc(): Promise<boolean> {
  const res = await fetch("/api/auth/desktop/handoff", {
    method: "POST",
    credentials: "same-origin",
  });
  const body = (await res.json().catch(() => ({}))) as { link?: string; error?: string };
  if (!res.ok || !body.link?.startsWith("hearth://connect?nonce=")) {
    throw new Error(body.error ?? "Couldn't reach Hearth. Try again in a moment.");
  }
  location.href = body.link;
  return true;
}

export function DesktopSettings() {
  const [devices, { refetch }] = createResource(() =>
    call<{ devices: Device[] }>("").then((b) => b.devices),
  );
  const desktop = () => devices()?.find((d) => d.name === "desktop");
  const [code, setCode] = createSignal<string | null>(null);
  const [asked, setAsked] = createSignal(false);

  const connect = async () => {
    try {
      setAsked(await connectThisPc());
      // The app pairs itself again; show it once it has.
      window.setTimeout(() => void refetch(), 15_000);
    } catch (err) {
      reportError(err);
    }
  };
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
        Hearth for Windows: Hearth in its own window, notifications, dictation into any app, and
        Jarvis a hotkey away. Install it on your PC, then connect it here.
      </p>
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
