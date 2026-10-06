// End-to-end check that the web app rides through Hearth being slow, down or restarting: errors
// and timeouts at start-up, on actions and on the live feed, each faked with page.route. After
// each one the app must come back by itself, in the same page, without a reload.
//
//   HEARTH_DEV_AUTH=1 HEARTH_WEB_DIST=apps/web/dist hearth serve    (in another terminal)
//   HEARTH_E2E_URL=http://localhost:4400 node apps/web/e2e/resilience.ts
//
// The server needs development login on (loopback only), so no passkey is involved.
// HEARTH_E2E_CHROME points at a Chromium to use instead of Playwright's own download.

import { chromium, type Locator, type Page, type Route } from "playwright";
import { home } from "./home.ts";

const base = process.env.HEARTH_E2E_URL ?? "http://localhost:4400";
const tag = Date.now().toString(36).slice(-4);
const UNREACHABLE = "Can't reach Hearth right now. Try again in a moment.";

const browser = await chromium.launch(
  process.env.HEARTH_E2E_CHROME ? { executablePath: process.env.HEARTH_E2E_CHROME } : {},
);
// The service worker answers page loads itself; these checks are about the app inside.
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  serviceWorkers: "block",
});
const page = await context.newPage();
const problems: string[] = [];
page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));

const badGateway = (r: Route) =>
  r.fulfill({ status: 502, contentType: "text/html", body: "<h1>502 Bad Gateway</h1>" });

/** Opens the app afresh and marks the page, so a later check can tell it was never reloaded. */
async function boot(p: Page) {
  await p.goto(base);
  await p.evaluate("window.sameLoad = true");
}
async function sameLoad(p: Page) {
  const same = await p.evaluate("window.sameLoad === true");
  if (!same) throw new Error("the page reloaded");
}
/** Runs an action as the app would, from the page (same origin, dev login). */
async function runAction(p: Page, name: string, input: unknown) {
  return p.evaluate(
    async ([n, i]) => {
      const res = await fetch(`/api/actions/${n}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(i),
      });
      return res.json();
    },
    [name, input] as const,
  );
}
const inboxRow = (p: Page, title: string) => p.locator("li", { hasText: title });
type Box = { x: number; y: number; width: number; height: number };
async function box(l: Locator): Promise<Box> {
  const b = await l.boundingBox();
  if (!b) throw new Error("not on the page");
  return b;
}
const overlap = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
/** Waits for earlier toasts to go, so the next one checked for is new. */
const noToasts = (p: Page) =>
  p.getByText(UNREACHABLE).first().waitFor({ state: "detached", timeout: 10_000 });

async function step(name: string, fn: (p: Page) => Promise<void>) {
  await fn(page);
  console.log(`✓ ${name}`);
}

try {
  await step("start-up: a proxy's 502, then Hearth comes back", async (p) => {
    await p.route("**/api/auth/me", badGateway);
    await boot(p);
    await p.getByRole("heading", { name: "Can't reach Hearth" }).waitFor();
    await p.unroute("**/api/auth/me");
    // Tries again by itself, after about a second.
    await home(p).waitFor({ timeout: 10_000 });
    await sameLoad(p);
  });

  await step("start-up: a 500, and the Try again button", async (p) => {
    await p.route("**/api/auth/me", (r) =>
      r.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }),
    );
    await boot(p);
    await p.getByRole("heading", { name: "Can't reach Hearth" }).waitFor();
    if (await p.getByText("boom").count()) throw new Error("the server's error text was shown");
    await p.unroute("**/api/auth/me");
    await p.getByRole("button", { name: "Try again" }).click();
    // Signed in here before, so Hearth is drawn under the notice: it's back once that's gone.
    await p.getByRole("heading", { name: "Can't reach Hearth" }).waitFor({ state: "detached" });
    await home(p).waitFor({ timeout: 5_000 });
    await sameLoad(p);
  });

  await step("start-up: a request that never answers gives up, then recovers", async (p) => {
    let first = true;
    await p.route("**/api/auth/me", async (r) => {
      if (!first) return r.continue();
      first = false;
      // Left hanging: the app stops waiting after 10 s.
    });
    await boot(p);
    // Signed in here before, so Hearth is drawn at once while the server is still being asked.
    await home(p).waitFor({ timeout: 5_000 });
    const drawn = await p.locator("main").elementHandle();
    const notice = p.getByRole("heading", { name: "Can't reach Hearth" });
    await notice.waitFor({ timeout: 15_000 });
    // Keys don't reach what's covered: this would go to Tasks.
    await p.keyboard.press("g");
    await p.keyboard.press("t");
    await notice.waitFor({ state: "detached", timeout: 10_000 });
    await home(p).waitFor();
    if (await p.getByRole("heading", { name: "Tasks", exact: true }).count())
      throw new Error("a key went to the screen under the notice");
    // The notice was over what was drawn, not instead of it: anything typed there is still there.
    if (!(await drawn?.evaluate((m) => m.isConnected))) throw new Error("Hearth was drawn again");
    await p.unroute("**/api/auth/me");
    await sameLoad(p);
  });

  await step("actions: 502, 500 and a timeout say so plainly, then work", async (p) => {
    await p.keyboard.press("g");
    await p.keyboard.press("t");
    await p.getByRole("heading", { name: "Tasks" }).waitFor();
    const field = p.getByPlaceholder("New task… (press c)");
    const title = `Water the plants ${tag}`;
    const attempts: [string, (r: Route) => Promise<void>][] = [
      ["502", badGateway],
      ["timeout", (r) => r.abort("timedout")],
    ];
    for (const [what, fail] of attempts) {
      await noToasts(p);
      await p.route("**/api/actions/task.create", fail);
      await field.fill(title);
      await field.press("Enter");
      await p.getByText(UNREACHABLE).last().waitFor();
      if (await p.getByText(title, { exact: true }).count())
        throw new Error(`a task showed after a ${what}`);
      await p.unroute("**/api/actions/task.create");
    }
    await p.route("**/api/actions/task.create", (r) =>
      r.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ status: "error", code: "failed", message: "Couldn't save it." }),
      }),
    );
    await field.fill(title);
    await field.press("Enter");
    await p.getByText("Couldn't save it.").waitFor();
    await p.unroute("**/api/actions/task.create");
    // The text is still there to send again.
    if ((await field.inputValue()) !== title) throw new Error("the typed task was lost");
    await field.press("Enter");
    await p.getByText(title, { exact: true }).first().waitFor();
    await field.blur();
    await sameLoad(p);
  });

  await step("a change that fails is put back as it was", async (p) => {
    await noToasts(p);
    await p.keyboard.press("g");
    await p.keyboard.press("i");
    await p.getByRole("heading", { name: "Updates" }).waitFor();
    const title = `Renew the passport ${tag}`;
    const made = (await runAction(p, "inbox.notify", { title })) as { result: { id: string } };
    const row = inboxRow(p, title);
    const selected = p.locator('li[data-active="true"]', { hasText: title });
    // Arrives over the live feed.
    await row.waitFor();
    // Focus in a row puts the keyboard on it, wherever it landed among earlier items.
    await row.getByRole("button", { name: /^Actions for/ }).focus();
    await selected.waitFor();
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    await p.route("**/api/actions/inbox.mark", async (r) => {
      await held;
      await badGateway(r);
    });
    // This row's done, not another's.
    const sent = p.waitForRequest((r) => {
      if (!r.url().endsWith("/api/actions/inbox.mark")) return false;
      const body = r.postDataJSON() as { ids?: string[]; state?: string } | null;
      return body?.state === "done" && body.ids?.includes(made.result.id) === true;
    });
    await p.keyboard.press("e");
    await sent;
    // Gone at once, before Hearth answers...
    await row.waitFor({ state: "detached", timeout: 2_000 });
    release();
    // ...and back when it says no, saying so.
    await row.waitFor();
    await p.getByText(UNREACHABLE).last().waitFor();
    await p.unroute("**/api/actions/inbox.mark");
    await selected.waitFor();
    await p.keyboard.press("e");
    await inboxRow(p, title).waitFor({ state: "detached" });
    await p.waitForTimeout(1_000);
    if (await inboxRow(p, title).count()) throw new Error("the done item came back");
    await sameLoad(p);
  });

  await step("live feed: refused at start, banner, then back with live updates", async (p) => {
    await p.route("**/api/events**", badGateway);
    await boot(p);
    await home(p).waitFor();
    await p.getByRole("status").filter({ hasText: "Reconnecting…" }).waitFor({ timeout: 10_000 });
    await p.unroute("**/api/events**");
    await p
      .getByRole("status")
      .filter({ hasText: "Reconnecting…" })
      .waitFor({ state: "detached", timeout: 40_000 });
    // Hearth opens on Today; a notice shows under Updates. Opened first, so the row can only
    // arrive over the feed that just came back.
    await p.keyboard.press("g");
    await p.keyboard.press("i");
    await p.getByRole("heading", { name: "Updates" }).waitFor();
    const title = `Call the bank ${tag}`;
    await runAction(p, "inbox.notify", { title });
    await inboxRow(p, title).waitFor({ timeout: 5_000 });
    await sameLoad(p);
  });

  await step("an update notice and Reconnecting… show together", async (p) => {
    await p.route("**/api/health/deep", (r) =>
      r.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ build: "a-newer-build", migrations: { ok: true } }),
      }),
    );
    await p.route("**/api/events**", badGateway);
    await boot(p);
    const banner = p.getByRole("status").filter({ hasText: "Reconnecting…" });
    const updated = p.getByText("Hearth was updated.");
    const reload = p.getByRole("button", { name: "Reload" });
    await updated.waitFor({ timeout: 10_000 });
    await banner.waitFor({ timeout: 10_000 });
    const shown = await box(banner);
    for (const part of [updated, reload])
      if (overlap(shown, await box(part)))
        throw new Error("the update notice covers Reconnecting…");
    // Nothing covers Reload either (a trial click checks, without reloading).
    await reload.click({ trial: true, timeout: 2_000 });
    await p.unrouteAll();
  });

  await step("Ask Jarvis's window looks again when it's shown after you sign in", async (p) => {
    await p.route("**/api/auth/me", (r) =>
      r.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ signedIn: false, principal: null, kind: null, needsSetup: false }),
      }),
    );
    await p.goto(`${base}/chat?compact=1`);
    await p.getByText("Sign in to Hearth first", { exact: false }).waitFor();
    await p.unroute("**/api/auth/me");
    // The app shows its kept window again.
    await p.evaluate("window.dispatchEvent(new Event('focus'))");
    await p.getByText("Ask Jarvis", { exact: true }).waitFor({ timeout: 5_000 });
  });

  await step("live feed: refused because the session ended goes to sign-in", async (p) => {
    let meCalls = 0;
    await p.route("**/api/events**", (r) =>
      r.fulfill({ status: 401, contentType: "application/json", body: '{"error":"Sign in."}' }),
    );
    await p.route("**/api/auth/me", async (r) => {
      meCalls += 1;
      if (meCalls === 1) return r.continue();
      await r.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ signedIn: false, principal: null, kind: null, needsSetup: false }),
      });
    });
    await boot(p);
    await p.getByRole("button", { name: "Sign in with your passkey" }).waitFor({ timeout: 15_000 });
    await sameLoad(p);
    await p.unrouteAll();
  });

  if (problems.length) throw new Error(`Problems:\n${problems.join("\n")}`);
  console.log("Resilience checks passed.");
} finally {
  await browser.close();
}
