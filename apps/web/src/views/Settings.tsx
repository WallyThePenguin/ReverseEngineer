// Settings: pause Jarvis's initiative, see Hearth's health, and manage what Jarvis may do
// without asking.

import { startRegistration } from "@simplewebauthn/browser";
import { For, Show } from "solid-js";
import { Badge, Button, PaneHeader } from "../components/ui.tsx";
import { authPost } from "../lib/api.ts";
import { ago } from "../lib/format.ts";
import { toast } from "../lib/live.ts";
import { act, useAction } from "../lib/query.ts";
import type { StandingRule, SystemStatus } from "../lib/types.ts";
import { ChromeSettings } from "./ChromeSettings.tsx";
import { GoogleSettings } from "./GoogleSettings.tsx";
import { RoutineSettings } from "./RoutineSettings.tsx";
import { SignInSettings } from "./SignInSettings.tsx";

export async function setPaused(paused: boolean) {
  if (await act(paused ? "jarvis.pause" : "jarvis.resume")) {
    toast.show(
      paused
        ? "Jarvis is paused. It still answers you, and alerts still come through."
        : "Jarvis is back on.",
    );
  }
}

const TONE = { ok: "ok", degraded: "warn", failing: "bad" } as const;

/** Adds another passkey (your phone, a security key) while you're signed in. */
async function addPasskey() {
  try {
    const options =
      await authPost<Parameters<typeof startRegistration>[0]["optionsJSON"]>("register/options");
    const response = await startRegistration({ optionsJSON: options });
    await authPost("register/verify", { response, label: navigator.platform || "Passkey" });
    toast.show("Passkey added.");
  } catch (err) {
    const e = err as Error;
    toast.show(
      e.name === "NotAllowedError" ? "The passkey prompt was closed." : e.message,
      "error",
    );
  }
}

export function Settings() {
  const status = useAction<SystemStatus>("system.status");
  const rules = useAction<StandingRule[]>("standing_rule.list");

  return (
    <div class="flex h-full flex-col">
      <PaneHeader title="Settings" />
      <div class="flex-1 space-y-8 overflow-auto px-5 py-4">
        <section class="space-y-2">
          <h2 class="font-semibold">Jarvis</h2>
          <Show when={status.data}>
            {(s) => (
              <div class="flex items-center gap-3 rounded-md bg-sunk px-3 py-3">
                <div class="flex-1">
                  <p class="font-medium">{s().jarvisPaused ? "Paused" : "On"}</p>
                  <p class="text-sm text-muted">
                    {s().jarvisPaused
                      ? "Jarvis only answers you. Its own initiative is off; deadline and failure alerts still arrive."
                      : "Jarvis answers you and also acts on its own: briefs, reminders, follow-ups."}
                  </p>
                </div>
                <Button
                  kind={s().jarvisPaused ? "primary" : "plain"}
                  onClick={() => void setPaused(!s().jarvisPaused)}
                >
                  {s().jarvisPaused ? "Resume" : "Pause"}
                </Button>
              </div>
            )}
          </Show>
        </section>

        <section class="space-y-2">
          <h2 class="font-semibold">Jarvis may do without asking</h2>
          <p class="text-sm text-muted">
            Things other people would see, or that are hard to undo, wait for your yes unless you
            add them here. Rules never apply when outside content (an email, a web page) started the
            request.
          </p>
          <Show
            when={(rules.data ?? []).length > 0}
            fallback={<p class="text-sm text-faint">No rules. Jarvis asks every time.</p>}
          >
            <ul class="space-y-1">
              <For each={rules.data}>
                {(r) => (
                  <li class="flex items-center gap-3 rounded-md bg-sunk px-3 py-2">
                    <code class="font-mono text-sm">{r.action}</code>
                    <span class="flex-1 text-sm text-muted">{r.note}</span>
                    <Button
                      small
                      kind="danger"
                      onClick={() => void act("standing_rule.delete", { id: r.id })}
                    >
                      Remove
                    </Button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>

        <ChromeSettings />

        <GoogleSettings />

        <SignInSettings />

        <RoutineSettings />

        <section class="space-y-2">
          <h2 class="font-semibold">Sign-in</h2>
          <div class="flex items-center gap-3">
            <p class="flex-1 text-sm text-muted">
              Add a passkey on another device, like your phone, so you can sign in there too.
            </p>
            <Button onClick={() => void addPasskey()}>Add a passkey</Button>
          </div>
        </section>

        <section class="space-y-2">
          <h2 class="font-semibold">Health</h2>
          <ul class="space-y-1">
            <For each={Object.entries(status.data?.components ?? {})}>
              {([name, h]) => (
                <li class="flex items-center gap-3 text-sm">
                  <Badge tone={TONE[h.status]}>{h.status}</Badge>
                  <span class="w-20 font-medium">{name}</span>
                  <span class="flex-1 text-muted">{h.detail}</span>
                  <span class="text-xs text-faint">{ago(h.at)}</span>
                </li>
              )}
            </For>
          </ul>
        </section>

        <section class="space-y-2">
          <h2 class="font-semibold">Coming up</h2>
          <ul class="space-y-1 text-sm">
            <For each={status.data?.schedules ?? []}>
              {(s) => (
                <li class="flex gap-3">
                  <span class="flex-1 font-mono text-xs">{s.id}</span>
                  <span class="text-muted">
                    {s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : ""}
                  </span>
                </li>
              )}
            </For>
          </ul>
        </section>
      </div>
    </div>
  );
}
