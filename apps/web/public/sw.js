// Hearth's service worker: opens the app at once from the last page seen (and when the PC can't be
// reached), and shows notifications. The API is never cached; everything you see comes live from
// your PC.

// The page itself, and the built files of each build, a cache per build. A new build's page is
// kept once its files are; the files of builds before the last go then (the last may still be
// open), so the cache holds two builds, not every one since.
// v3 lets go of a page kept without its files (by the worker before this one kept them), so the
// one kept next has them.
const SHELL = "hearth-shell-v3";
const ASSETS = "hearth-assets";
const assetsOf = (build) => `${ASSETS}:${build}`;
/**
 * Where SHELL notes the last build seen to start here. The page notes it once the app is up, so
 * it can move itself on to a new build (UpdateNotice), and forgets it before a reload, which then
 * comes from the PC (lib/version.ts).
 */
const STARTED = "/.started";
/**
 * The page's first script, which puts on its theme. The page doesn't draw until it has run, so it
 * comes from SHELL at once and is fetched again behind it; it's never awaited from the PC.
 */
const BOOT = "/theme-boot.js";
/** How long a page may take from the PC before the last one seen opens instead. */
const NAVIGATE_TIMEOUT_MS = 3000;

self.addEventListener("install", (e) => {
  e.waitUntil(
    Promise.all([
      fetch("/")
        .then((res) => (res.ok && isPage(res) ? rememberPage(res).catch(forgetStarted) : undefined))
        .catch(() => {}),
      caches
        .open(SHELL)
        .then((c) => c.addAll(["/manifest.webmanifest", BOOT]))
        .catch(() => {}),
    ]),
  );
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

/** Which build a page is from, as the PC names it (its hearth-build stamp). */
const buildOf = (html) => html.match(/<meta name="hearth-build" content="([^"]+)"/)?.[1] ?? null;

/** The built files a page loads before anything else: its script, its preloads, its styles. */
const filesOf = (html) => [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);

/** The next page opened comes from the PC first: the newest page couldn't be kept. */
const forgetStarted = () => caches.open(SHELL).then((c) => c.delete(STARTED));

/** Hearth's page, as opposed to one of its files opened as a page (/version.json, an icon). */
const isPage = (res) => (res.headers.get("content-type") ?? "").startsWith("text/html");

/** A place in the app (/today, /mail+thread/…), as opposed to one of its files (/version.json). */
const inApp = (url) => !url.pathname.split("/").pop().includes(".");

/**
 * The desktop app's small windows (/capture, /chat?compact=1: lib/desktop.ts). They're opened to
 * type into at once, so they come from the PC: one opened from a page kept from before an update
 * would move itself on to the new one as you start typing. The app opens them once the PC has
 * answered (offline::load), so this costs no wait, and a slow answer is waited for: only a PC out
 * of reach, or answering with an error, opens the kept page (and Ask, which has no notice, would
 * stay on it).
 */
const smallWindow = (url) => {
  const path = url.pathname.replace(/\/+$/, "");
  return path === "/capture" || (path === "/chat" && url.searchParams.get("compact") === "1");
};

/** The build of the page kept, which files fetched now are kept with. */
const keptBuild = async () => {
  const kept = await caches.match("/");
  return kept ? buildOf(await kept.text()) : null;
};

/**
 * Saves the newest page. If it's from a new build, its files are kept first (a page kept without
 * them would open blank with the PC out of reach), and then the files of builds before the one it
 * replaces go: that one's page may still be open (it may have opened from here) and ask for them.
 * A page that isn't the app (no build stamp) isn't saved. Throws if it couldn't be kept.
 */
async function rememberPage(res) {
  const shell = await caches.open(SHELL);
  const old = await shell.match("/");
  const html = await res.clone().text();
  const [before, now] = [old ? buildOf(await old.text()) : null, buildOf(html)];
  if (!now) return;
  if (before !== now) await (await caches.open(assetsOf(now))).addAll(filesOf(html));
  await shell.put("/", res);
  if (before === now) return;
  const keep = [assetsOf(now), assetsOf(before)];
  const names = await caches.keys();
  await Promise.all(
    names.filter((k) => k.startsWith(ASSETS) && !keep.includes(k)).map((k) => caches.delete(k)),
  );
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A place in the app opens at once from the last page seen, so the app starts while the PC is
 * still being reached; the newest page is fetched meanwhile and kept for next time. A new build
 * reaches the open page through its update check, which reloads into it from the PC when that
 * loses nothing (UpdateNotice). Only a build whose page has started opens this way: one that
 * hasn't (a broken update, which can't move itself on) is asked of the PC each time, so the update
 * that fixes it arrives as soon as there is one.
 */
async function openSaved(e) {
  const [saved, started] = await Promise.all([caches.match("/"), caches.match(STARTED)]);
  if (!saved || !started) return navigate(e);
  if (buildOf(await saved.clone().text()) !== (await started.text())) return navigate(e);
  e.waitUntil(
    fetch(e.request)
      .then((res) => (res.ok && isPage(res) ? rememberPage(res).catch(forgetStarted) : undefined))
      .catch(() => {}),
  );
  return saved;
}

/**
 * The newest page from the PC: before any is kept, while the one kept hasn't started, on a reload
 * (lib/version.ts), and for its files opened as pages. If it's out of reach, answers with an error
 * (Hearth restarting behind a proxy) or takes more than a few seconds (unless `patient`: the small
 * windows), the last page seen opens instead, and the app inside it waits for Hearth to come back.
 */
function navigate(e, patient = false) {
  const network = fetch(e.request);
  let answered = false;
  const saved = () => caches.match("/");
  // Saved even when it arrives after the saved page has opened. (Copied before the page reads it.)
  e.waitUntil(
    network
      .then((res) =>
        res.ok && isPage(res) ? rememberPage(res.clone()).catch(forgetStarted) : undefined,
      )
      .catch(() => {}),
  );
  const fromNetwork = network.then(
    async (res) => (res.status >= 500 && (await saved())) || res,
    async () => (await saved()) || Response.error(),
  );
  if (patient) return fromNetwork;
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
  if (url.pathname === BOOT) {
    const fresh = fetch(e.request).then(async (res) => {
      if (res.ok) await (await caches.open(SHELL)).put(BOOT, res.clone());
      return res;
    });
    e.waitUntil(fresh.catch(() => {}));
    e.respondWith(caches.match(BOOT).then((hit) => hit || fresh));
    return;
  }
  if (e.request.mode === "navigate")
    e.respondWith(smallWindow(url) ? navigate(e, true) : inApp(url) ? openSaved(e) : navigate(e));
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
