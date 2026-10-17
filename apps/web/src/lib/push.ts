// Notifications on this device: whether they're on here, turning them on, and the devices that get
// them. Settings' Phone section and Today's "Turn on notifications" share one read of it.

import { createQuery } from "@tanstack/solid-query";
import { createSignal } from "solid-js";
import { alertsOnThisDevice } from "./alertsHere.ts";
import { request } from "./api.ts";
import { queryClient, reportError, toast } from "./live.ts";

export interface PushDevice {
  endpoint: string;
  label: string;
  createdAt: string;
  lastSentAt: string | null;
}

const call = <T>(path: string, method = "GET", json?: unknown) =>
  request<T>(`/api/push${path}`, method, json);

const keyBytes = (base64url: string) => {
  const b64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

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

export function usePush() {
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
  // The set-up checklist counts a phone that gets alerts too.
  const refetch = () => {
    void query.refetch();
    void queryClient.invalidateQueries({ queryKey: ["system.status"] });
  };
  const [busy, setBusy] = createSignal(false);
  const here = alertsOnThisDevice();
  // In Hearth's Windows app, its own notifications take the place of the browser's.
  const desktopApp = here === "desktop";
  const supported = here === "push";
  /** An iPhone or iPad in Safari: notifications come once Hearth is on the Home Screen. */
  const needsHomeScreen = here === "home-screen";
  /** This device gets notifications. */
  const on = () => {
    const s = query.data;
    return !!s?.mine && s.devices.some((d) => d.endpoint === s.mine);
  };
  /** Known to be off here, and able to be turned on: not while that's still being read. */
  const canTurnOn = () => supported && query.data !== undefined && !on();

  const turnOn = async () => {
    setBusy(true);
    try {
      if ((await Notification.requestPermission()) !== "granted") {
        toast.show("Notifications are blocked for Nook. Allow them in this device's settings.");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: keyBytes(query.data!.publicKey),
        }));
      await call("", "POST", { ...sub.toJSON(), label: thisDevice() });
      toast.show("Notifications are on for this device.");
      refetch();
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (endpoint: string) => {
    try {
      if (endpoint === query.data?.mine) await (await currentSubscription())?.unsubscribe();
      await call("", "DELETE", { endpoint });
      refetch();
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
  return {
    query,
    busy,
    desktopApp,
    supported,
    needsHomeScreen,
    on,
    canTurnOn,
    turnOn,
    remove,
    test,
  };
}
