// "Test Jarvis's Chrome" (D52): a few steps on a page Hearth serves, run as Jarvis through the
// same path its turns use (actions, then the browser bridge over HTTP to the server's driver, B1),
// each one timed. The page is Hearth's own, so nothing leaves the PC.
import { jarvisCaller, Kernel } from "@hearth/kernel";
import { BROWSER_SERVICE, type BrowserClient } from "./client.ts";

export const TEST_PAGE_PATH = "/api/browser/test-page";

/** The page the test works on: a button to press and a field to type into. */
export const TEST_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nook's Chrome test</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem}</style>
</head>
<body>
<h1>Nook's Chrome test</h1>
<p>Pip is checking that it can use Chrome. This tab closes by itself in a moment.</p>
<p><button type="button" onclick="document.getElementById('pressed').textContent = 'Button pressed'">Press me</button></p>
<p id="pressed">Not pressed yet</p>
<p><label>Your name <input name="name" autocomplete="off" oninput="document.getElementById('echo').textContent = 'Typed: ' + this.value"></label></p>
<p id="echo"></p>
</body>
</html>`;

/** Its own policy: the inline handlers above, and nothing from anywhere else. */
export const TEST_PAGE_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

export interface SelfTestStep {
  step: string;
  label: string;
  ok: boolean;
  ms: number;
  /** What went wrong, in a sentence, when it failed. */
  detail?: string;
}

export interface SelfTestResult {
  ok: boolean;
  steps: SelfTestStep[];
  totalMs: number;
}

const LABELS: Record<string, string> = {
  tabs: "See Chrome's tabs",
  open: "Open a page",
  read: "Read it",
  click: "Click a button",
  type: "Type into a field",
  check: "See what changed",
  screenshot: "Take a screenshot",
  close: "Close the tab",
};

/**
 * Runs the steps as Jarvis. `baseUrl` is where Chrome reaches Hearth's server; `client` is Jarvis's
 * way to Chrome (the server passes Jarvis's own HTTP client, so the test takes Jarvis's path).
 */
export async function runSelfTest(
  kernel: Kernel,
  baseUrl: string,
  client: BrowserClient,
): Promise<SelfTestResult> {
  // Jarvis's own way in: its browser client, not the server's bridge.
  const asJarvis = new Kernel({
    db: kernel.db,
    registry: kernel.registry,
    clock: kernel.clock,
    services: { ...kernel.services, [BROWSER_SERVICE]: client },
  });
  const caller = jarvisCaller("agent");
  const steps: SelfTestStep[] = [];
  const started = Date.now();

  const step = async <T>(name: string, input: unknown, action: string): Promise<T | null> => {
    const at = Date.now();
    const res = await asJarvis.execute<T>(action, input, caller).catch((err: unknown) => ({
      status: "error" as const,
      message: err instanceof Error ? err.message : String(err),
    }));
    const ms = Date.now() - at;
    const label = LABELS[name] ?? name;
    if (res.status === "ok") {
      steps.push({ step: name, label, ok: true, ms });
      return res.result as T;
    }
    // An error says what failed; a refusal or a wait for your yes says why.
    const detail = "message" in res ? res.message : res.reason;
    steps.push({ step: name, label, ok: false, ms, detail });
    return null;
  };
  // The step answered, but not with what the test page should show.
  const wrong = (detail: string): void => {
    const last = steps[steps.length - 1];
    if (last) Object.assign(last, { ok: false, detail });
  };

  let tabId: number | null = null;
  // Stops at the first step that fails; the tab is closed either way.
  const run = async () => {
    if (!(await step("tabs", {}, "browser.tabs"))) return;
    const url = `${baseUrl.replace(/\/$/, "")}${TEST_PAGE_PATH}`;
    const opened = await step<{ tabId: number }>("open", { url }, "browser.open");
    if (!opened) return;
    tabId = opened.tabId;
    // The way Jarvis's turns work a page: read it for refs, act by them, read what changed.
    const page = await step<{ text: string }>(
      "read",
      { tabId, filter: "interactive" },
      "browser.read_page",
    );
    if (!page) return;
    const button = /button "Press me" \[(ref_\d+)\]/.exec(page.text)?.[1];
    const field = /textbox "Your name" \[(ref_\d+)\]/.exec(page.text)?.[1];
    if (!button || !field) return wrong("The test page didn't read as expected.");
    if (!(await step("click", { tabId, ref: button }, "browser.click"))) return;
    if (!(await step("type", { tabId, ref: field, text: "Nook" }, "browser.type"))) return;
    const after = await step<{ text: string }>("check", { tabId }, "browser.get_text");
    if (!after) return;
    if (!after.text.includes("Button pressed") || !after.text.includes("Typed: Nook"))
      return wrong("The click or the typing didn't reach the page.");
    await step("screenshot", { tabId }, "browser.screenshot");
  };
  try {
    await run();
  } finally {
    if (tabId !== null) await step("close", { tabId }, "browser.close");
  }
  return { ok: steps.every((s) => s.ok), steps, totalMs: Date.now() - started };
}
