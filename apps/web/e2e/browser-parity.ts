// D52's end-to-end checks, run by browser.ts with the real extension: the fixed ID and protocol,
// dialogs, pop-ups, back and forward, key combinations, "leave site?" in Jarvis's own tab, and
// "Test Jarvis's Chrome".

import type { Page, Worker } from "playwright";

/** Pages the test site serves for these checks, by path. */
export const PARITY_PAGES: Record<string, string> = {
  "/dialogs": `<!doctype html><title>Dialogs</title>
    <button onclick="alert('Saved!')">Show alert</button>
    <button onclick="out.textContent = confirm('Remove the note?') ? 'kept: yes' : 'kept: no'">Remove note</button>
    <button onclick="out.textContent = 'name: ' + prompt('Your name?', 'Ana')">Ask name</button>
    <p id="out">nothing yet</p>`,
  "/popup": `<!doctype html><title>Popup</title>
    <button onclick="window.open('/second')">Open second</button>`,
  "/keys": `<!doctype html><title>Keys</title>
    <input id="k" aria-label="Note" oninput="v.textContent = 'value: [' + this.value + ']'">
    <p id="v">value: []</p><p id="b">plain</p>
    <script>k.addEventListener("keydown", (e) => { if (e.ctrlKey && e.key === "b") b.textContent = "bold"; });</script>`,
  "/draft": `<!doctype html><title>Draft</title><button onclick="s.textContent = 'started'">Start</button>
    <p id="s"></p>
    <script>addEventListener("beforeunload", (e) => { e.preventDefault(); e.returnValue = ""; });</script>`,
  "/form": `<!doctype html><title>Form</title>
    <form method="post" action="/sent"><input name="n" aria-label="Note" value="x"><button>Send note</button></form>`,
  "/sent": "<!doctype html><title>Sent</title><p>Sent</p>",
};

/** The ID the extension's fixed key gives it (D52). */
const EXTENSION_ID = "jcpelnnklghgcdhcmdbmpflehbehpkhh";

type Body = { status: string; result?: Record<string, unknown>; message?: string };

export interface ParityContext {
  hearth: Page;
  siteUrl: string;
  extensionId: string;
  /** The extension's service worker, to open a tab the way you would. */
  worker: Worker;
  /** How many forms the test site has been sent. */
  posts(): number;
  check(ok: unknown, what: string): void;
}

export async function parityChecks(context: ParityContext) {
  const { hearth, siteUrl, extensionId, worker, posts, check } = context;
  /** Runs an action as you, from the Hearth page, and returns the whole answer. */
  const attempt = (name: string, input: unknown) =>
    hearth.evaluate(
      async ([n, i]) => {
        const r = await fetch(`/api/actions/${n}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(i),
        });
        return (await r.json()) as Body;
      },
      [name, input] as const,
    );
  const act = async <T = Record<string, unknown>>(name: string, input: unknown): Promise<T> => {
    const res = await attempt(name, input);
    if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
    return res.result as T;
  };
  /** The reference browser.read gave the element named `label`. */
  const refOf = async (tabId: number, label: string) => {
    const { text } = await act<{ text: string }>("browser.read", { tabId });
    const ref = new RegExp(`\\[\\w[\\w ]* (E\\d+): ${label}`).exec(text)?.[1];
    if (!ref) throw new Error(`No "${label}" on the page: ${text}`);
    return ref;
  };
  const textOf = async (tabId: number) =>
    (await act<{ text: string }>("browser.read", { tabId })).text;

  // The fixed key gives the extension its one ID, and it speaks protocol 3 (B1).
  check(extensionId === EXTENSION_ID, "the extension's key gives it the fixed ID");
  const status = (await hearth.evaluate(() =>
    fetch("/api/browser/status").then((r) => r.json()),
  )) as Record<string, unknown>;
  check(
    status.protocol === 3 && status.extensionId === EXTENSION_ID && status.problem === null,
    "Hearth sees protocol 3 and the expected ID, with no problem",
  );

  // Dialogs: a step that opens one says so, everything else waits, and browser.dialog answers.
  const { tabId } = await act<{ tabId: number }>("browser.open", { url: `${siteUrl}dialogs` });
  const alerted = await act<{ dialog?: { type: string } }>("browser.click", {
    tabId,
    ref: await refOf(tabId, "Show alert"),
  });
  check(alerted.dialog?.type === "alert", "a click that opens an alert says so");
  const blocked = await attempt("browser.read", { tabId });
  check(
    blocked.status === "error" && String(blocked.message).includes("dialog is open"),
    "reading while the dialog is open fails at once instead of hanging",
  );
  const tabs = await act<{ tabs: { tabId: number; dialog?: { type: string } }[] }>(
    "browser.tabs",
    {},
  );
  check(
    tabs.tabs.find((t) => t.tabId === tabId)?.dialog?.type === "alert",
    "browser.tabs shows the dialog",
  );
  await act("browser.dialog", { tabId, accept: true });
  await act("browser.click", { tabId, ref: await refOf(tabId, "Remove note") });
  await act("browser.dialog", { tabId, accept: false });
  check((await textOf(tabId)).includes("kept: no"), "dismissing a confirm answers it with Cancel");
  await act("browser.click", { tabId, ref: await refOf(tabId, "Ask name") });
  await act("browser.dialog", { tabId, accept: true, promptText: "Ben" });
  check((await textOf(tabId)).includes("name: Ben"), "a prompt gets the answer Jarvis types");

  // Pop-ups: a tab Jarvis's tab opens is Jarvis's, and the step says which one.
  await act("browser.navigate", { tabId, url: `${siteUrl}popup` });
  const popped = await act<{ opened?: { tabId: number; url: string }[] }>("browser.click", {
    tabId,
    ref: await refOf(tabId, "Open second"),
  });
  const opened = popped.opened?.[0];
  check(opened?.url.endsWith("/second"), "a click that opens a pop-up says which tab it opened");
  const withPopup = await act<{ tabs: { tabId: number; openedFrom?: number }[] }>(
    "browser.tabs",
    {},
  );
  check(
    withPopup.tabs.some((t) => t.tabId === opened?.tabId && t.openedFrom === tabId),
    "the pop-up is Jarvis's to use, opened from its tab",
  );
  if (opened) await act("browser.close", { tabId: opened.tabId });

  // A tab you open yourself stays yours, though Chrome names the tab that was in front as its
  // opener, as it does when you duplicate Jarvis's tab.
  const yours = (await worker.evaluate(`(async () => {
    await chrome.tabs.update(${tabId}, { active: true });
    const t = await chrome.tabs.duplicate(${tabId});
    return { id: t.id, opener: t.openerTabId };
  })()`)) as { id: number; opener?: number };
  check(yours.opener === tabId, "Chrome names Jarvis's tab as the opener of a copy you make of it");
  await hearth.waitForTimeout(1000);
  const afterYours = await act<{ tabs: { tabId: number }[] }>("browser.tabs", {});
  check(
    !afterYours.tabs.some((t) => t.tabId === yours.id),
    "a tab you open yourself isn't Jarvis's, whatever Chrome names as its opener",
  );
  await worker.evaluate(`chrome.tabs.remove(${yours.id})`);

  // Back, forward and reload.
  await act("browser.navigate", { tabId, url: `${siteUrl}second` });
  const back = await act<{ finalUrl: string }>("browser.navigate", { tabId, url: "back" });
  check(back.finalUrl.endsWith("/popup"), "navigate back goes back");
  const forward = await act<{ finalUrl: string }>("browser.navigate", { tabId, url: "forward" });
  check(forward.finalUrl.endsWith("/second"), "navigate forward goes forward");
  const reload = await act<{ title: string }>("browser.navigate", { tabId, url: "reload" });
  check(reload.title === "Second", "reload reloads");

  // Reloading a page a form sent loads it afresh, without sending the form again. The site is
  // trusted for this, so the press itself needn't ask.
  const sites = await act<{ allowed: string[]; blocked: string[] }>("browser.sites", {});
  const host = new URL(siteUrl).hostname;
  await act("browser.set_sites", { allowed: [...sites.allowed, host], blocked: sites.blocked });
  await act("browser.navigate", { tabId, url: `${siteUrl}form` });
  await act("browser.click", { tabId, ref: await refOf(tabId, "Send note") });
  const sent = posts();
  const fresh = await act<{ title: string }>("browser.navigate", { tabId, url: "reload" });
  check(
    sent === 1 && fresh.title === "Sent" && posts() === sent,
    "reloading a page a form sent doesn't send the form again",
  );
  await act("browser.set_sites", { allowed: sites.allowed, blocked: sites.blocked });

  // Key combinations, with modifiers and repeats.
  await act("browser.navigate", { tabId, url: `${siteUrl}keys` });
  await act("browser.type", { tabId, ref: await refOf(tabId, "Note"), text: "hello" });
  await act("browser.key", { tabId, keys: "ctrl+b" });
  check((await textOf(tabId)).includes("bold"), "ctrl+b reaches the page as one combination");
  await act("browser.key", { tabId, keys: "ctrl+a Backspace" });
  check((await textOf(tabId)).includes("value: []"), "ctrl+a then Backspace clears the field");
  await act("browser.key", { tabId, keys: "x", repeat: 3 });
  check((await textOf(tabId)).includes("value: [xxx]"), "repeat presses the keys again");

  // "Leave site?" in Jarvis's own tab is accepted by itself when Jarvis moves on.
  await act("browser.navigate", { tabId, url: `${siteUrl}draft` });
  await act("browser.click", { tabId, ref: await refOf(tabId, "Start") });
  const left = await act<{ finalUrl: string }>("browser.navigate", {
    tabId,
    url: `${siteUrl}second`,
  });
  check(left.finalUrl.endsWith("/second"), 'Jarvis leaves its own page past a "leave site?"');
  await act("browser.close", { tabId });

  // "Test Jarvis's Chrome": every step, as Jarvis, on Hearth's own test page.
  const test = (await hearth.evaluate(() =>
    fetch("/api/browser/self-test", { method: "POST" }).then((r) => r.json()),
  )) as { ok: boolean; steps: { step: string; ok: boolean; ms: number; detail?: string }[] };
  if (!test.ok) console.error(JSON.stringify(test.steps));
  check(test.ok && test.steps.length === 8, "Test Jarvis's Chrome passes every step");
  console.log(`  ${test.steps.map((s) => `${s.step} ${s.ms} ms`).join(", ")}`);
  const log = (await hearth.evaluate(() => fetch("/api/browser/log").then((r) => r.json()))) as {
    entries: { kind: string }[];
    stats: { calls: number };
  };
  check(
    log.entries.some((e) => e.kind === "connect") && log.stats.calls > 0,
    "the link's log has the connect and counts the calls",
  );
}
