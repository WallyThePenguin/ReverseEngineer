// Settings > Google: connect an account, see its status, and pick which calendars Hearth syncs.

import { For, onMount, Show } from "solid-js";
import { Badge, Button } from "../components/ui.tsx";
import { ago } from "../lib/format.ts";
import { toast } from "../lib/live.ts";
import { act, useAction } from "../lib/query.ts";
import type { CalendarSetup, MailAccount } from "../lib/types.ts";
import { syncLine } from "./MailSyncStatus.tsx";

export function GoogleSettings() {
  const setup = useAction<CalendarSetup>("calendar.calendars");
  const mail = useAction<MailAccount[]>("mail.accounts");
  onMount(() => {
    // Back from Google's sign-in: say how it went, then tidy the address.
    const msg = new URLSearchParams(location.search).get("google");
    if (msg) {
      toast.show(msg);
      history.replaceState(null, "", location.pathname);
    }
  });
  const onPc = () => ["localhost", "127.0.0.1"].includes(location.hostname);
  return (
    <section class="space-y-2">
      <h2 class="font-semibold">Google</h2>
      <Show
        when={setup.data?.configured}
        fallback={
          <p class="text-sm text-muted">
            Google isn't set up on this PC yet. It needs a Google sign-in key in Hearth's settings
            file (HEARTH_GOOGLE_CLIENT_ID and HEARTH_GOOGLE_CLIENT_SECRET).
          </p>
        }
      >
        <ul class="space-y-1">
          <For each={setup.data?.accounts ?? []}>
            {(a) => (
              <li class="flex items-center gap-3 rounded-md bg-sunk px-3 py-2 text-sm">
                <Badge tone={a.status === "ok" ? "ok" : "bad"}>
                  {a.status === "ok" ? "connected" : a.status}
                </Badge>
                <span class="flex-1 font-medium">{a.email}</span>
                <span class="text-xs text-faint">since {ago(a.connectedAt)}</span>
                <Button
                  small
                  kind="danger"
                  onClick={async () => {
                    if (await act("google.disconnect", { email: a.email }))
                      toast.show(`Disconnected ${a.email}.`);
                  }}
                >
                  Disconnect
                </Button>
              </li>
            )}
          </For>
        </ul>
        <Show when={(setup.data?.accounts ?? []).some((a) => a.lastError)}>
          <p class="text-sm text-bad">
            {(setup.data?.accounts ?? []).find((a) => a.lastError)?.lastError}
          </p>
        </Show>
        <div class="flex items-center gap-3">
          <p class="flex-1 text-sm text-muted">
            {onPc()
              ? "Connect a Google account so Jarvis can see and plan your calendar."
              : "Connecting finishes on this PC's own browser (Google sends you back to localhost), so open Hearth on the PC to connect."}
          </p>
          <Button
            kind="primary"
            onClick={() => location.assign("/api/google/connect?for=calendar")}
          >
            Connect Google Calendar
          </Button>
          <Button onClick={() => location.assign("/api/google/connect?for=calendar,gmail")}>
            Connect Gmail too
          </Button>
        </div>
        <Show when={(mail.data ?? []).length > 0}>
          <ul class="space-y-1 text-sm">
            <For each={mail.data}>
              {(m) => (
                <li class="flex items-center gap-3">
                  <Badge tone={syncLine(m).tone}>{syncLine(m).badge}</Badge>
                  <span class="flex-1">{m.address}</span>
                  <span class={`text-xs ${syncLine(m).tone === "bad" ? "text-bad" : "text-faint"}`}>
                    {syncLine(m).text}
                    {m.setAside > 0
                      ? ` · ${m.setAside} message${m.setAside === 1 ? "" : "s"} couldn't be brought in`
                      : ""}
                  </span>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Show when={(setup.data?.calendars ?? []).length > 0}>
          <ul class="space-y-1">
            <For each={setup.data?.calendars}>
              {(c) => (
                <li class="flex items-center gap-3 text-sm">
                  <input
                    type="checkbox"
                    checked={c.selected}
                    aria-label={`Sync ${c.title}`}
                    onChange={(e) =>
                      void act("calendar.choose", { id: c.id, selected: e.currentTarget.checked })
                    }
                  />
                  <span
                    class="size-2.5 rounded-full"
                    style={{ background: c.color ?? "var(--color-faint)" }}
                  />
                  <span class="flex-1">{c.title}</span>
                  <span class="text-xs text-faint">
                    {c.lastError
                      ? c.lastError
                      : c.lastSyncedAt
                        ? `synced ${ago(c.lastSyncedAt)}`
                        : c.selected
                          ? "not synced yet"
                          : "off"}
                  </span>
                </li>
              )}
            </For>
          </ul>
          <Button
            small
            onClick={() => void act("calendar.sync").then((r) => r && toast.show("Synced."))}
          >
            Sync now
          </Button>
        </Show>
      </Show>
    </section>
  );
}
