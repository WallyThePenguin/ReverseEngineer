// Settings, Passkeys: yours, and where each works. Hearth's own address takes any passkey. The
// desktop app's window on this PC, at localhost, takes a Windows Hello passkey of its own, so it
// can sign itself in again without your browser (D69).

import { startRegistration } from "@simplewebauthn/browser";
import { createQuery } from "@tanstack/solid-query";
import { For, Show } from "solid-js";
import { QueryView } from "../components/QueryView.tsx";
import { Button } from "../components/ui.tsx";
import { authPost, request } from "../lib/api.ts";
import { inDesktopApp } from "../lib/desktop.ts";
import { ago } from "../lib/format.ts";
import { toast } from "../lib/live.ts";
import { windowPasskeyHere } from "../lib/wayIn.ts";

interface Passkey {
  label: string;
  /** Made in the window on this PC, and works only there. */
  window: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

const WINDOW_LABEL = "This PC's Hearth window";

/** Adds a passkey where you are: another of yours, or Windows Hello for the window. */
async function addPasskey(forWindow: boolean): Promise<void> {
  try {
    const options =
      await authPost<Parameters<typeof startRegistration>[0]["optionsJSON"]>("register/options");
    const response = await startRegistration({ optionsJSON: options });
    await authPost("register/verify", {
      response,
      label: forWindow ? WINDOW_LABEL : navigator.platform || "Passkey",
    });
    toast.show(
      forWindow
        ? "Windows Hello is set up. When this window is signed out, it signs in again with it."
        : "Passkey added.",
    );
  } catch (err) {
    const e = err as Error;
    // Whether Windows Hello opens inside the app's window isn't known for every PC: say so.
    const why = forWindow
      ? e.name === "NotAllowedError"
        ? "Windows Hello was closed, or couldn't open in this window. If it never opens here, this window signs in from your browser instead: Settings, Desktop app, Connect Hearth on this PC."
        : `Windows Hello couldn't add a passkey in this window: ${e.message}`
      : e.name === "NotAllowedError"
        ? "The passkey prompt was closed."
        : e.message;
    toast.show(why, "error");
  }
}

export function PasskeySettings() {
  const keys = createQuery(() => ({
    queryKey: ["passkeys"],
    queryFn: () => request<{ passkeys: Passkey[]; origin: string }>("/api/auth/passkeys"),
  }));
  return (
    <section class="space-y-2">
      <h2 class="font-semibold">Passkeys</h2>
      <QueryView query={keys} what="your passkeys" isEmpty={() => false}>
        {(data) => {
          const host = () => new URL(data().origin).host;
          const where = () =>
            location.origin === data().origin
              ? "own"
              : windowPasskeyHere(location, data().origin, inDesktopApp())
                ? "window"
                : "elsewhere";
          const add = async () => {
            await addPasskey(where() === "window");
            void keys.refetch();
          };
          return (
            <>
              <ul class="space-y-1">
                <For each={data().passkeys}>
                  {(p) => (
                    <li class="flex flex-wrap items-center gap-x-3 rounded-md bg-sunk px-3 py-2 text-sm">
                      <span class="font-medium">{p.label || "Passkey"}</span>
                      <span class="flex-1 text-muted">
                        {p.window ? "Works in Hearth's window on this PC" : `Works at ${host()}`}
                      </span>
                      <span class="text-xs text-faint">
                        {p.lastUsedAt ? `Used ${ago(p.lastUsedAt)}` : `Added ${ago(p.createdAt)}`}
                      </span>
                    </li>
                  )}
                </For>
              </ul>
              <Show
                when={where() !== "elsewhere"}
                fallback={
                  <p class="text-sm text-muted">
                    Passkeys are added at Hearth's address, {host()}.
                  </p>
                }
              >
                <div class="flex items-center gap-3">
                  <p class="flex-1 text-sm text-muted">
                    {where() === "window"
                      ? "Windows Hello for this window: when it's signed out, it signs in again here, without your browser."
                      : "Add a passkey on another device, like your phone, so you can sign in there too."}
                  </p>
                  <Button onClick={() => void add()}>
                    {where() === "window"
                      ? "Add a passkey for this PC's Hearth window"
                      : "Add a passkey"}
                  </Button>
                </div>
              </Show>
            </>
          );
        }}
      </QueryView>
    </section>
  );
}
