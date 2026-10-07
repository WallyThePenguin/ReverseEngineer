// Hearth's service worker: opens the app at once from the last page seen (and when the PC can't be
// reached), and shows notifications. The API is never cached; everything you see comes live from
// your PC.

// The page itself, and the built files of each build, a cache per build. When a new build's page
// arrives, the files of builds before the last go (the last may still be open), so the cache
// holds two builds, not every one since.
const SHELL = "hearth-shell-v2";
const ASSETS = "hearth-assets";
const assetsOf = (build) => `${ASSETS}:${build}`;
/** Where SHELL notes the last build whose page started (main.tsx says so once it has). */
const STARTED = "/.started";
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
        Promise.all(
          keys
            .filter((k) => !keep.includes(k) && !k.startsWith(`${ASSETS}:`))
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

/** Which build a page is from: its main script's hashed name. */
const buildOf = (html) => html.match(/\/assets\/index-[\w-]+\.js/)?.[0] ?? null;

/** Hearth's page, as opposed to one of its files opened as a page (/version.json, an icon). */
const isPage = (res) => (res.headers.get("content-type") ?? "").startsWith("text/html");

/** A place in the app (/today, /mail+thread/…), as opposed to one of its files (/version.json). */
const inApp = (url) => !url.pathname.split("/").pop().includes(".");

/** The build of the page kept, which files fetched now are kept with. */
const keptBuild = async () => {
  const kept = await caches.match("/");
  return kept ? buildOf(await kept.text()) : null;
};

/**
 * Saves the newest page. If it's from a new build, the files of builds before the one it replaces
 * go: that one's page may still be open (it may have opened from here) and ask for them. A page
 * that isn't the app (no main script) isn't saved.
 */
async function rememberPage(res) {
  const shell = await caches.open(SHELL);
  const old = await shell.match("/");
  const [before, now] = await Promise.all([
    old ? old.text().then(buildOf) : null,
    res.clone().text().then(buildOf),
  ]);
  if (!now) return;
  await shell.put("/", res);
  if (before === now) return;
  const keep = [assetsOf(now), assetsOf(before)];
  const names = await caches.keys();
  await Promise.all(
    names.filter((k) => k.startsWith(ASSETS) && !keep.includes(k)).map((k) => caches.delete(k)),
  );
}

self.addEventListener("message", (e) => {
  const build = e.data?.started;
  if (typeof build === "string" && /^\/assets\/index-[\w-]+\.js$/.test(build))
    e.waitUntil(caches.open(SHELL).then((c) => c.put(STARTED, new Response(build))));
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** The newest page on its way from the PC after one opened from the cache, until it's kept. */
let refreshing = null;

/**
 * A place in the app opens at once from the last page seen, so the app starts while the PC is
 * still being reached; the newest page is fetched meanwhile and kept for next time. A new build
 * reaches the open page through its update check, which reloads into it when that loses nothing
 * (UpdateNotice). A page asked for while the newest is still on its way, as that reload is, waits
 * for it to be kept (a few seconds at most), so it opens the new build. Only a build whose page
 * has started opens this way: one that hasn't (a broken update, which can't move itself on) is
 * asked of the PC each time, so the update that fixes it arrives as soon as there is one.
 */
async function openSaved(e) {
  await Promise.race([refreshing, wait(NAVIGATE_TIMEOUT_MS)]);
  const [saved, started] = await Promise.all([caches.match("/"), caches.match(STARTED)]);
  if (!saved || !started) return navigate(e);
  if (buildOf(await saved.clone().text()) !== (await started.text())) return navigate(e);
  const fresh = fetch(e.request)
    .then((res) => (res.ok && isPage(res) ? rememberPage(res) : undefined))
    .catch(() => {});
  refreshing = fresh;
  e.waitUntil(
    fresh.finally(() => {
      if (refreshing === fresh) refreshing = null;
    }),
  );
  return saved;
}

/**
 * The newest page from the PC: before any is kept, while the one kept hasn't started, and for its
 * files opened as pages. If it's out of reach, answers with an error (Hearth restarting behind a proxy) or takes
 * more than a few seconds, the last page seen opens instead, and the app inside it waits for
 * Hearth to come back.
 */
function navigate(e) {
  const network = fetch(e.request);
  let answered = false;
  const saved = () => caches.match("/");
  // Saved even when it arrives after the saved page has opened. (Copied before the page reads it.)
  e.waitUntil(
    network
      .then((res) => (res.ok && isPage(res) ? rememberPage(res.clone()) : undefined))
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
              e.waitUntil(
                keptBuild()
                  .then((build) => caches.open(assetsOf(build)))
                  .then((c) => c.put(e.request, copy)),
              );
            }
            return res;
          }),
      ),
    );
    return;
  }
  if (e.request.mode === "navigate") e.respondWith(inApp(url) ? openSaved(e) : navigate(e));
});

self.addEventListener("push", (e) => {
  let m = { title: "Hearth", body: "", url: "/today", tag: undefined };
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
  let target = new URL("/today", self.location.origin).href;
  try {
    const u = new URL(e.notification.data?.url || "/today", self.location.origin);
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
