// B1's end-to-end checks, run by browser.ts with the real extension: the server's driver reading
// and acting through it (refs, a frame from another site, a batch, a screenshot and its points,
// hover, scrolling, the console), the tab group a turn's tabs share, and how long each step takes.

import type { Page, Worker } from "playwright";

/** Pages the test site serves for these checks, by path. */
export const DRIVER_PAGES: Record<string, string> = {
  "/driver": `<!doctype html><title>Driver</title>
    <style>body{font:16px sans-serif;margin:20px}</style>
    <h1>Basket</h1>
    <p><label>Your email <input id="email"></label></p>
    <p><label>Size <select id="size"><option>S</option><option>M</option><option>L</option></select></label></p>
    <p><label><input type="checkbox" id="gift"> Gift wrap</label></p>
    <p><button onclick="out.textContent = 'added: ' + email.value + ' ' + size.value + (gift.checked ? ' gift' : '')">Add to basket</button></p>
    <p id="out">empty</p>
    <p><button onmouseover="menu.textContent = 'menu open'">Menu</button> <span id="menu"></span></p>
    <canvas id="pad" width="200" height="100" style="border:1px solid #888"></canvas> <span id="at"></span>
    <iframe id="f" title="Other site" style="width:400px;height:80px"></iframe>
    <div style="height:2500px"></div>
    <button onclick="far.textContent = 'far clicked'">Far down</button> <span id="far"></span>
    <script>
      pad.addEventListener("click", (e) => {
        const r = pad.getBoundingClientRect();
        at.textContent = "at " + Math.round(e.clientX - r.left) + "," + Math.round(e.clientY - r.top);
      });
      // localhost and 127.0.0.1 are different sites, so Chrome puts the frame in its own process.
      f.src = location.origin.replace("127.0.0.1", "localhost") + "/frame";
      fetch("/missing");
    </script>`,
  "/frame": `<!doctype html><title>Frame</title>
    <button onclick="done.textContent = 'frame clicked'">Frame button</button> <span id="done"></span>`,
};

type Body = { status: string; result?: Record<string, unknown>; message?: string };
// biome-ignore lint/suspicious/noExplicitAny: checks read what they expect from results.
type Result = Record<string, any>;

export interface DriverContext {
  hearth: Page;
  siteUrl: string;
  /** The extension's service worker, to see the tab groups. */
  worker: Worker;
  /** The test page at an address, to measure where things are on it. */
  pageAt(url: string): Promise<Page>;
  check(ok: unknown, what: string): void;
}

/** The ref read_page gave the element with this role and name. */
function refOf(text: string, role: string, name: string): string {
  const ref = new RegExp(`${role} "${name}" \\[(ref_\\d+)\\]`).exec(text)?.[1];
  if (!ref) throw new Error(`No ${role} "${name}" on the page:\n${text}`);
  return ref;
}

const pct = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))] ?? 0;

export async function driverChecks(context: DriverContext) {
  const { hearth, siteUrl, worker, pageAt, check } = context;
  const times: { name: string; ms: number }[] = [];
  const act = async (name: string, input: unknown): Promise<Result> => {
    const started = performance.now();
    const res = (await hearth.evaluate(
      async ([n, i]) => {
        const r = await fetch(`/api/actions/${n}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(i),
        });
        return (await r.json()) as Body;
      },
      [name, input] as const,
    )) as Body;
    times.push({ name, ms: performance.now() - started });
    if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
    return res.result as Result;
  };
  const textOf = async (tabId: number) => String((await act("browser.get_text", { tabId })).text);

  const url = `${siteUrl}driver`;
  const { tabId } = await act("browser.open", { url });
  // The frame loads a moment after the page.
  let page = "";
  for (let i = 0; i < 40 && !page.includes("Frame button"); i++) {
    if (i) await hearth.waitForTimeout(250);
    page = String((await act("browser.read_page", { tabId, filter: "interactive" })).text);
  }
  check(
    page.includes('textbox "Your email" [ref_') && page.includes('button "Add to basket" [ref_'),
    "read_page reads the page through the extension, with refs",
  );
  check(page.includes('button "Frame button" [ref_'), "and a frame from another site with it");

  const found = await act("browser.find", { tabId, query: "basket" });
  check(String(found.text).includes("Add to basket"), "find picks out what matches");

  // A batch fills in the form and presses the button, in one request.
  const done = await act("browser.batch", {
    tabId,
    steps: [
      {
        action: "type",
        input: { ref: refOf(page, "textbox", "Your email"), text: "me@example.com" },
      },
      { action: "form_input", input: { ref: refOf(page, "combobox", "Size"), value: "L" } },
      { action: "form_input", input: { ref: refOf(page, "checkbox", "Gift wrap"), value: "on" } },
      { action: "click", input: { ref: refOf(page, "button", "Add to basket") } },
    ],
  });
  check(!done.stopped, "a batch of four steps runs to the end");
  check(
    (await textOf(tabId)).includes("added: me@example.com L gift"),
    "the batch typed, chose, ticked and pressed",
  );

  await act("browser.click", { tabId, ref: refOf(page, "button", "Frame button") });
  const after = String((await act("browser.read_page", { tabId })).text);
  check(after.includes("frame clicked"), "a click by ref lands inside the other site's frame");

  await act("browser.hover", { tabId, ref: refOf(page, "button", "Menu") });
  check((await textOf(tabId)).includes("menu open"), "hover points at something without a click");

  // A screenshot's points are where clicks land, on a canvas that has no refs.
  const shot = await act("browser.screenshot", { tabId });
  const image = shot.modelImages?.[0]?.data as string | undefined;
  check(image && image.length > 1000 && shot.imageW > 0, "a screenshot comes back with its size");
  const box = await (await pageAt(url)).locator("#pad").boundingBox();
  if (!box) throw new Error("No box for the canvas");
  const s = Number(shot.scale);
  await act("browser.click", {
    tabId,
    coordinate: [Math.round((box.x + 50) * s), Math.round((box.y + 30) * s)],
  });
  const at = /at (\d+),(\d+)/.exec(await textOf(tabId));
  check(
    at && Math.abs(Number(at[1]) - 50) <= 1 && Math.abs(Number(at[2]) - 30) <= 1,
    "a click at a point in the screenshot lands there on the page",
  );
  const zoomed = await act("browser.zoom", { tabId, region: [0, 0, 200, 100] });
  check(zoomed.modelImages?.[0]?.data, "zoom looks closer at part of the screenshot");

  // Scrolling, and something far down the page.
  const far = refOf(page, "button", "Far down");
  await act("browser.scroll_to", { tabId, ref: far });
  await act("browser.click", { tabId, ref: far });
  check((await textOf(tabId)).includes("far clicked"), "scroll_to brings it into view to click");
  const up = await act("browser.scroll", { tabId, direction: "up", amount: 10 });
  check(up.moved === true, "scroll moves the page with the wheel");

  const logged = await act("browser.console", { tabId, pattern: "404" });
  check(JSON.stringify(logged).includes("404"), "console shows the page's failed request");
  await act("browser.tab_select", { tabId });
  await act("browser.close", { tabId });

  // A turn's tabs share a group of their own; another turn's go in another.
  const rpc = (params: Record<string, unknown>) =>
    hearth.evaluate(async (p) => {
      const r = await fetch("/api/browser/rpc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "tabs.open", params: p }),
      });
      return ((await r.json()) as { result: { tabId: number } }).result.tabId;
    }, params);
  const opened = [
    await rpc({ url: `${siteUrl}second`, group: "turn-a" }),
    await rpc({ url: `${siteUrl}second`, group: "turn-a" }),
    await rpc({ url: `${siteUrl}second`, group: "turn-b" }),
  ];
  const groups = (await worker.evaluate(`(async () => {
    const out = [];
    for (const id of ${JSON.stringify(opened)}) {
      const t = await chrome.tabs.get(id);
      out.push({ group: t.groupId, title: (await chrome.tabGroups.get(t.groupId)).title });
    }
    return out;
  })()`)) as { group: number; title: string }[];
  const [a1, a2, b] = groups;
  check(
    a1 && a2 && b && a1.group === a2.group && a1.group !== b.group,
    "each turn's tabs share a tab group of their own",
  );
  check(a1?.title.startsWith("Jarvis "), "named for when the turn started");
  for (const id of opened) await act("browser.close", { tabId: id });

  const ms = times.map((t) => t.ms).sort((x, y) => x - y);
  const steps = times
    .filter((t) => t.name !== "browser.open")
    .map((t) => t.ms)
    .sort((x, y) => x - y);
  console.log(
    `  ${times.length} actions through the extension: p50 ${Math.round(pct(ms, 50))} ms, p95 ${Math.round(pct(ms, 95))} ms; without opens, p50 ${Math.round(pct(steps, 50))} ms, p95 ${Math.round(pct(steps, 95))} ms; slowest ${Math.round(ms.at(-1) ?? 0)} ms`,
  );
  check((ms.at(-1) ?? 0) < 10_000, "no step waits 10 seconds");
}
