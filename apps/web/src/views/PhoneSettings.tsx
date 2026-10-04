// Settings for the phone: put Hearth on its home screen, and turn on notifications for
// approvals, the morning brief and the interruptions Jarvis is allowed to make.

import { createQuery } from "@tanstack/solid-query";
import { createSignal, For, Show } from "solid-js";
import { QueryView } from "../components/QueryView.tsx";
import { Button } from "../components/ui.tsx";
import { request } from "../lib/api.ts";
import { ago } from "../lib/format.ts";
import { queryClient, reportError, toast } from "../lib/live.ts";

interface PushDevice {
  endpoint: string;
  label: string;
  createdAt: string;
  lastSentAt: string | null;
}

const call = <T,>(path: string, method = "GET", json?: unknown) =>
  request<T>(`/api/push${path}`, method, json);

const keyBytes = (base64url: string) => {
  const b64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

const installed = () =>
  window.matchMedia("(display-mode: standalone)").matches ||
  (navigator as { standalone?: boolean }).standalone === true;

const thisDevice = () => {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android phone";
  return "This browser";
};

async function currentSubscription() {
  if (!("serviceWorker" in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export function PhoneSettings() {
  const query = createQuery(() => ({
    queryKey: ["push.devices"],
    queryFn: async () => {
      const [{ publicKey, devices }, mine] = await Promise.all([
        call<{ publicKey: string; devices: PushDevice[] }>(""),
        currentSubscription(),
      ]);
      return { publicKey, devices, mine: mine?.endpoint ?? null };
    },
  }));
  const state = () => query.data;
  // The set-up checklist counts a phone that gets alerts too.
  const refetch = () => {
    void query.refetch();
    void queryClient.invalidateQueries({ queryKey: ["system.status"] });
  };
  const [busy, setBusy] = createSignal(false);
  const supported = "serviceWorker" in navigator && "PushManager" in window;
  const on = () => {
    const s = state();
    return !!s?.mine && s.devices.some((d) => d.endpoint === s.mine);
  };

  const turnOn = async () => {
    setBusy(true);
    try {
      if ((await Notification.requestPermission()) !== "granted") {
        toast.show("Notifications are blocked for Hearth. Allow them in this device's settings.");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: keyBytes(state()!.publicKey),
        }));
      await call("", "POST", { ...sub.toJSON(), label: thisDevice() });
      toast.show("Notifications are on for this device.");
      void refetch();
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (endpoint: string) => {
    try {
      if (endpoint === state()?.mine) await (await currentSubscription())?.unsubscribe();
      await call("", "DELETE", { endpoint });
      void refetch();
    } catch (err) {
      reportError(err);
    }
  };
  const test = async () => {
    try {
      const { sent } = await call<{ sent: number }>("/test", "POST");
      toast.show(sent ? "Sent. It should arrive in a moment." : "No device took it.");
    } catch (err) {
      reportError(err);
    }
  };

  return (
    <section class="space-y-3">
      <h2 class="font-semibold">Phone</h2>
      <Show when={!installed()}>
        <p class="text-sm text-muted">
          On your phone, open Hearth in Safari, tap Share, then Add to Home Screen. It opens like an
          app, and on an iPhone that's also what lets it show notifications.
        </p>
      </Show>
      <QueryView query={query} what="this device's notifications">
        {(s) => (
          <>
            <div class="flex items-center gap-3 rounded-md bg-sunk px-3 py-3">
              <div class="flex-1">
                <p class="font-medium">
                  Notifications{" "}
                  {supported ? (on() ? "on here" : "off here") : "aren't available here"}
                </p>
                <p class="text-sm text-muted">
                  Approvals, your morning brief, and the interruptions Jarvis is allowed to make.
                </p>
              </div>
              <Show when={supported && !on()}>
                <Button kind="primary" disabled={busy()} onClick={() => void turnOn()}>
                  Turn on here
                </Button>
              </Show>
              <Show when={s().devices.length > 0}>
                <Button onClick={() => void test()}>Send a test</Button>
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
                    <Button small kind="danger" onClick={() => void remove(d.endpoint)}>
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
