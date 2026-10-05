// Settings > Google: connect accounts, see their status, pick which calendars Hearth syncs and
// the one it puts new events on.

import { For, onMount, Show } from "solid-js";
import { Badge, Button } from "../components/ui.tsx";
import { ago } from "../lib/format.ts";
import { toast } from "../lib/live.ts";
import { act, useAction } from "../lib/query.ts";
import type { CalendarSetup, MailAccount } from "../lib/types.ts";
import { DisconnectGoogle } from "./GoogleDisconnect.tsx";
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
              <li class="flex flex-wrap items-center gap-3 rounded-md bg-sunk px-3 py-2 text-sm">
                <Badge tone={a.status === "ok" ? "ok" : "bad"}>
                  {a.status === "ok" ? "connected" : a.status}
                </Badge>
                <span class="flex-1 font-medium">{a.email}</span>
                <span class="text-xs text-faint">since {ago(a.connectedAt)}</span>
                <DisconnectGoogle email={a.email} />
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
        <Show when={setup.data && setup.data.calendars.length > 0}>
          <Calendars setup={setup.data as CalendarSetup} />
        </Show>
      </Show>
    </section>
  );
}

type Cal = CalendarSetup["calendars"][number];

/** Each account's calendars, which ones sync, and the one new events go to. */
function Calendars(props: { setup: CalendarSetup }) {
  const byAccount = () =>
    props.setup.accounts
      .map((a) => ({
        email: a.email,
        cals: props.setup.calendars.filter((c) => c.account === a.email),
      }))
      .filter((a) => a.cals.length > 0);
  const many = () => byAccount().length > 1;
  const writable = () => props.setup.calendars.filter((c) => c.canWrite);
  const label = (c: Cal) => (many() ? `${c.title} (${c.account})` : c.title);
  // A calendar two accounts share syncs through one of them.
  const elsewhere = (c: Cal) =>
    props.setup.calendars.find((o) => o.googleId === c.googleId && o.id !== c.id && o.selected);
  return (
    <div class="space-y-2">
      <For each={byAccount()}>
        {(a) => (
          <div class="space-y-1">
            <Show when={many()}>
              <h3 class="text-xs font-medium text-muted">{a.email}</h3>
            </Show>
            <ul class="space-y-1">
              <For each={a.cals}>
                {(c) => (
                  <li class="flex items-center gap-3 text-sm">
                    <input
                      type="checkbox"
                      checked={c.selected}
                      disabled={!c.selected && Boolean(elsewhere(c))}
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
                        : !c.selected && elsewhere(c)
                          ? `syncs through ${elsewhere(c)?.account}`
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
          </div>
        )}
      </For>
      <div class="flex flex-wrap items-center gap-3 text-sm">
        <Show when={writable().length > 0}>
          <label class="flex items-center gap-2">
            New events go to
            <select
              class="rounded-md border border-line bg-panel px-2 py-1 text-sm"
              value={writable().find((c) => c.writeDefault)?.id ?? ""}
              onChange={(e) => void act("calendar.set_default", { id: e.currentTarget.value })}
            >
              <For each={writable()}>{(c) => <option value={c.id}>{label(c)}</option>}</For>
            </select>
          </label>
        </Show>
        <Button
          small
          onClick={() => void act("calendar.sync").then((r) => r && toast.show("Synced."))}
        >
          Sync now
        </Button>
      </div>
    </div>
  );
}
