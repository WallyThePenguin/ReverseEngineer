// Hearth's service worker: opens the app when the PC can't be reached, and shows notifications.
// The API is never cached; everything you see comes live from your PC.

// The page itself, and the built files of the build it comes from. When a new build's page
// arrives, the old build's files are dropped, so the cache holds one build, not every one since.
const SHELL = "hearth-shell-v2";
const ASSETS = "hearth-assets";
/** How long a page may take from the PC before the last one seen opens instead. */
const NAVIGATE_TIMEOUT_MS = 3000;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(["/", "/manifest.webmanifest"])));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  const keep = [SHELL, ASSETS];
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !keep.includes(k)).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

/** Which build a page is from: its main script's hashed name. */
const buildOf = (html) => html.match(/\/assets\/index-[\w-]+\.js/)?.[0] ?? null;

/** Hearth's page, as opposed to one of its files opened as a page (/version.json, an icon). */
const isPage = (res) => (res.headers.get("content-type") ?? "").startsWith("text/html");

/**
 * Saves the newest page. If it's from a new build, the old build's files go, unless the old
 * page is the one open right now (it opened from the cache) and may still ask for them; those
 * go with the next new build. A page that isn't the app (no main script) isn't saved.
 */
async function rememberPage(res, oldPageOpen) {
  const shell = await caches.open(SHELL);
  const old = await shell.match("/");
  const [before, now] = await Promise.all([
    old ? old.text().then(buildOf) : null,
    res.clone().text().then(buildOf),
  ]);
  if (!now) return;
  await shell.put("/", res);
  if (before && before !== now && !oldPageOpen) await caches.delete(ASSETS);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The newest page from the PC. If it's out of reach, answers with an error (Hearth restarting
 * behind a proxy) or takes more than a few seconds, the last page seen opens instead, and the
 * app inside it waits for Hearth to come back.
 */
function navigate(e) {
  const network = fetch(e.request);
  let answered = false;
  let openedSaved = false;
  const saved = async () => {
    const hit = await caches.match("/");
    if (hit) openedSaved = true;
    return hit;
  };
  // Saved even when it arrives after the saved page has opened. (Copied before the page reads it.)
  e.waitUntil(
    network
      .then((res) => (res.ok && isPage(res) ? rememberPage(res.clone(), openedSaved) : undefined))
      .catch(() => {}),
  );
  const fromNetwork = network.then(
    async (res) => (res.status >= 500 && (await saved())) || res,
    async () => (await saved()) || Response.error(),
  );
  // Too slow: the saved page if there is one, else keep waiting.
  const slow = wait(NAVIGATE_TIMEOUT_MS).then(
    async () => (!answered && (await saved())) || fromNetwork,
  );
  const answer = Promise.race([fromNetwork, slow]);
  answer.then(() => {
    answered = true;
  });
  return answer;
}

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
              e.waitUntil(caches.open(ASSETS).then((c) => c.put(e.request, copy)));
            }
            return res;
          }),
      ),
    );
    return;
  }
  if (e.request.mode === "navigate") e.respondWith(navigate(e));
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
  // Only ever a page of this app.
  let target = new URL("/inbox", self.location.origin).href;
  try {
    const u = new URL(e.notification.data?.url || "/inbox", self.location.origin);
    if (u.origin === self.location.origin) target = u.href;
  } catch {}
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ("focus" in w) return w.navigate(target).then((n) => (n || w).focus());
      }
      return self.clients.openWindow(target);
    }),
  );
});
