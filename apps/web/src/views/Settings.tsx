// Settings: pause Jarvis's initiative, see Hearth's health, and manage what Jarvis may do
// without asking.

import { startRegistration } from "@simplewebauthn/browser";
import { For, Show } from "solid-js";
import { Badge, Button, PaneHeader } from "../components/ui.tsx";
import { authPost } from "../lib/api.ts";
import { ago } from "../lib/format.ts";
import { jarvisLiveness } from "../lib/jarvis-health.ts";
import { toast } from "../lib/live.ts";
import { setPaused } from "../lib/pause.ts";
import { act, useAction } from "../lib/query.ts";
import type { StandingRule, SystemStatus } from "../lib/types.ts";
import { ChromeSettings } from "./ChromeSettings.tsx";
import { DesktopSettings } from "./DesktopSettings.tsx";
import { GithubSettings } from "./GithubSettings.tsx";
import { GoogleSettings } from "./GoogleSettings.tsx";
import { ImportSettings } from "./ImportSettings.tsx";
import { PhoneSettings } from "./PhoneSettings.tsx";
import { RoutineSettings } from "./RoutineSettings.tsx";
import { Anchor, SettingsNav } from "./SettingsNav.tsx";
import { SignInSettings } from "./SignInSettings.tsx";
import { SlackSettings } from "./SlackSettings.tsx";

const TONE = { ok: "ok", degraded: "warn", failing: "bad" } as const;
/** Health components by a name you'd use; any other goes by its own. */
const PART: Record<string, string> = {
  "sync.google": "Google",
  "sync.slack": "Slack",
  "sync.github": "GitHub",
  browser: "Chrome",
};

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
  /** Why Jarvis isn't answering, if it isn't, and what to do on the PC. */
  const notRunning = () => {
    const s = status.data;
    if (!s) return null;
    if (s.jarvisAlive === null)
      return "Jarvis hasn't checked in yet. On the PC, start it with: hearth restart jarvis";
    return jarvisLiveness({ data: s, dataUpdatedAt: status.dataUpdatedAt }).downSince
      ? "Jarvis isn't running. Hearth is trying to restart it; if it stays down, run on the PC: hearth restart jarvis"
      : null;
  };

  let scroller: HTMLDivElement | undefined;

  return (
    <div class="flex h-full flex-col">
      <PaneHeader title="Settings" />
      <div ref={scroller} class="flex-1 space-y-8 overflow-auto px-5 py-4">
        <SettingsNav root={() => scroller} />
        <Anchor id="jarvis">
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
            <Show when={notRunning()}>{(why) => <p class="text-sm text-bad">{why()}</p>}</Show>
          </section>
        </Anchor>

        <Anchor id="rules">
          <section class="space-y-2">
            <h2 class="font-semibold">Jarvis may do without asking</h2>
            <p class="text-sm text-muted">
              Things other people would see, or that are hard to undo, wait for your yes unless you
              add them here. Rules never apply when outside content (an email, a web page) started
              the request.
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
        </Anchor>

        <Anchor id="chrome">
          <ChromeSettings />
        </Anchor>
        <Anchor id="desktop">
          <DesktopSettings />
        </Anchor>
        <Anchor id="phone">
          <PhoneSettings />
        </Anchor>
        <Anchor id="google">
          <GoogleSettings />
        </Anchor>
        <Anchor id="slack">
          <SlackSettings />
        </Anchor>
        <Anchor id="github">
          <GithubSettings />
        </Anchor>
        <Anchor id="import">
          <ImportSettings />
        </Anchor>
        <Anchor id="signins">
          <SignInSettings />
        </Anchor>
        <Anchor id="routines">
          <RoutineSettings />
        </Anchor>

        <Anchor id="passkeys">
          <section class="space-y-2">
            <h2 class="font-semibold">Passkeys</h2>
            <div class="flex items-center gap-3">
              <p class="flex-1 text-sm text-muted">
                Add a passkey on another device, like your phone, so you can sign in there too.
              </p>
              <Button onClick={() => void addPasskey()}>Add a passkey</Button>
            </div>
          </section>
        </Anchor>

        <Anchor id="health">
          <section class="space-y-2">
            <h2 class="font-semibold">Health</h2>
            <ul class="space-y-1">
              <For
                each={Object.entries(status.data?.components ?? {})}
                fallback={
                  <li class="text-sm text-faint">
                    Nothing has reported yet. The worker, the syncs and the nightly backup report
                    here once they run.
                  </li>
                }
              >
                {([name, h]) => (
                  <li class="flex items-center gap-3 text-sm">
                    <Badge tone={TONE[h.status]}>{h.status}</Badge>
                    <span class="w-20 shrink-0 font-medium capitalize">{PART[name] ?? name}</span>
                    <span class="flex-1 text-muted">{h.detail}</span>
                    <span class="text-xs text-faint">{ago(h.at)}</span>
                  </li>
                )}
              </For>
            </ul>
          </section>
        </Anchor>

        <Anchor id="coming">
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
        </Anchor>
      </div>
    </div>
  );
}
