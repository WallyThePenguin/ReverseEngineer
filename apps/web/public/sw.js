// Hearth's service worker: opens the app when the PC can't be reached, and shows notifications.
// The API is never cached; everything you see comes live from your PC.

const SHELL = "hearth-shell-v1";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(["/", "/manifest.webmanifest"])));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/mcp") return;
  // Built files have their hash in the name, so a cached copy is always right.
  if (url.pathname.startsWith("/assets/")) {
    e.respondWith(
      caches.match(e.request).then(
        (hit) =>
          hit ||
          fetch(e.request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(SHELL).then((c) => c.put(e.request, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }
  // Pages: the newest from the PC, or the last one seen when it's out of reach.
  if (e.request.mode === "navigate") {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put("/", copy));
          }
          return res;
        })
        .catch(() => caches.match("/")),
    );
  }
});

self.addEventListener("push", (e) => {
  let m = { title: "Hearth", body: "", url: "/inbox", tag: undefined };
  try {
    m = { ...m, ...e.data.json() };
  } catch {}
  e.waitUntil(
    self.registration.showNotification(m.title, {
      body: m.body,
      tag: m.tag,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: m.url },
    }),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const path = e.notification.data?.url || "/inbox";
  const target = new URL(path.startsWith("/") ? path : "/inbox", self.location.origin).href;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ("focus" in w) return w.navigate(target).then((n) => (n || w).focus());
      }
      return self.clients.openWindow(target);
    }),
  );
});
