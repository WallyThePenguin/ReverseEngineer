// Settings for the phone: put Hearth on its home screen, and turn on notifications for
// approvals, the morning brief and the interruptions Jarvis is allowed to make (lib/push.ts).

import { For, Show } from "solid-js";
import { HomeScreenSteps } from "../components/HomeScreenSteps.tsx";
import { QueryView } from "../components/QueryView.tsx";
import { Button } from "../components/ui.tsx";
import { installed } from "../lib/alertsHere.ts";
import { ago } from "../lib/format.ts";
import { usePush } from "../lib/push.ts";

export function PhoneSettings() {
  const push = usePush();

  return (
    <section class="space-y-3">
      <h2 class="font-semibold">Phone</h2>
      <Show when={push.needsHomeScreen}>
        <HomeScreenSteps />
      </Show>
      <Show when={!installed() && !push.desktopApp && !push.needsHomeScreen}>
        <p class="text-sm text-muted">
          On your phone, open Nook in Safari, tap Share, then Add to Home Screen. It opens like an
          app, and on an iPhone that's also what lets it show notifications.
        </p>
      </Show>
      <QueryView query={push.query} what="this device's notifications">
        {(s) => (
          <>
            <div class="flex items-center gap-3 rounded-md bg-sunk px-3 py-3">
              <div class="flex-1">
                <p class="font-medium">
                  Notifications{" "}
                  {push.desktopApp
                    ? "here come from the Windows app"
                    : push.needsHomeScreen
                      ? "here need Nook on your Home Screen"
                      : push.supported
                        ? push.on()
                          ? "on here"
                          : "off here"
                        : "aren't available here"}
                </p>
                <p class="text-sm text-muted">
                  Approvals, your morning brief, and the interruptions Pip is allowed to make.
                </p>
              </div>
              <Show when={push.supported && !push.on()}>
                <Button kind="primary" disabled={push.busy()} onClick={() => void push.turnOn()}>
                  Turn on here
                </Button>
              </Show>
              <Show when={s().devices.length > 0}>
                <Button onClick={() => void push.test()}>Send a test</Button>
              </Show>
            </div>
            <ul class="space-y-1 text-sm">
              <For each={s().devices}>
                {(d) => (
                  <li class="flex items-center gap-2">
                    <span class="flex-1">
                      {d.label}
                      {d.endpoint === s().mine ? " (this one)" : ""}
                      <span class="text-faint">
                        {" "}
                        · {d.lastSentAt ? `last notified ${ago(d.lastSentAt)}` : "nothing sent yet"}
                      </span>
                    </span>
                    <Button small kind="danger" onClick={() => void push.remove(d.endpoint)}>
                      Remove
                    </Button>
                  </li>
                )}
              </For>
            </ul>
          </>
        )}
      </QueryView>
    </section>
  );
}
