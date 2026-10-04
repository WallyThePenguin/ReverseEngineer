// End-to-end check that a closed tab loses nothing (D59): in each editor (a note, a board, a
// spreadsheet, meeting notes) make an edit while Hearth takes the save and never answers, close
// the tab mid-save, open it again, and the edit reaches Hearth. Then a board edit made while Jarvis
// adds a card keeps both, a note deleted while open saves what was typed in it once restored, and
// one opened from the trash opens once it's restored.
// Runs its own server (development login, on HEARTH_E2E_PORT) against HEARTH_DATABASE_URL, and its
// own browser with the service worker off so saves can be held.
//
//   pnpm build:web
//   HEARTH_DATABASE_URL=postgres://... HEARTH_E2E_PORT=4690 node apps/web/e2e/integrity.ts
//
// HEARTH_E2E_CHROME points at a Chromium to use instead of Playwright's own download.

import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { type BrowserContext, chromium, type Page } from "playwright";

const port = Number(process.env.HEARTH_E2E_PORT ?? 4690);
const base = `http://localhost:${port}`;
const repo = join(import.meta.dirname, "../../..");
if (!process.env.HEARTH_DATABASE_URL) throw new Error("Set HEARTH_DATABASE_URL.");
const tag = Date.now().toString(36).slice(-4);

let hearth: ChildProcess | null = null;
async function start() {
  hearth = spawn(process.execPath, [join(repo, "apps/cli/src/main.ts"), "serve"], {
    cwd: repo,
    env: {
      ...process.env,
      HEARTH_WEB_DIST: join(repo, "apps/web/dist"),
      HEARTH_DEV_AUTH: "1",
      HEARTH_PORT: String(port),
      HEARTH_ORIGIN: base,
      HEARTH_CHROME_LAUNCH: "off",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 60; i++) {
    if (
      await fetch(`${base}/api/health`).then(
        (r) => r.ok,
        () => false,
      )
    )
      return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Hearth didn't start");
}
async function stop() {
  const h = hearth;
  hearth = null;
  if (!h || h.exitCode !== null) return;
  const exited = new Promise((r) => h.once("exit", r));
  h.kill();
  await exited;
}

async function step(name: string, fn: () => Promise<void>) {
  await fn();
  console.log(`✓ ${name}`);
}

/** Runs an action from the page, as the signed-in owner. */
async function act<T>(page: Page, name: string, input: unknown): Promise<T> {
  const out = (await page.evaluate(
    async ([name, input]) => {
      const r = await fetch(`/api/actions/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      return r.json();
    },
    [name, input] as const,
  )) as { status: string; result: T };
  if (out.status !== "ok") throw new Error(`${name}: ${JSON.stringify(out)}`);
  return out.result;
}

/** Hearth takes this action's requests and never answers them, until `release`. */
async function hold(context: BrowserContext, action: string) {
  const pattern = `**/api/actions/${action}`;
  await context.route(pattern, () => {});
  return () => context.unroute(pattern);
}

/**
 * Makes an edit in a tab whose saves hang, closes the tab mid-save, opens the record again in a
 * new tab, and waits until `saved` reads the edit back from Hearth.
 */
async function killTab(
  context: BrowserContext,
  o: {
    path: string;
    ready: (p: Page) => Promise<void>;
    action: string;
    edit: (p: Page) => Promise<void>;
    saved: (p: Page) => Promise<boolean>;
  },
) {
  const page = await context.newPage();
  await page.goto(`${base}${o.path}`);
  await o.ready(page);
  const release = await hold(context, o.action);
  let sent = 0;
  page.on("request", (r) => r.url().includes(`/api/actions/${o.action}`) && sent++);
  await o.edit(page);
  // The save went out (and hangs): close the tab while it's in flight.
  for (let i = 0; i < 50 && sent === 0; i++) await page.waitForTimeout(100);
  if (sent === 0) throw new Error(`no ${o.action} went out`);
  if (await o.saved(page)) throw new Error("the edit reached Hearth while saves were held");
  await page.close();
  await release();
  const again = await context.newPage();
  await again.goto(`${base}${o.path}`);
  await o.ready(again);
  for (let i = 0; i < 50; i++) {
    if (await o.saved(again)) return again;
    await again.waitForTimeout(200);
  }
  throw new Error(`the edit made before the tab closed never reached Hearth (${o.path})`);
}

await start();
const browser = await chromium.launch(
  process.env.HEARTH_E2E_CHROME ? { executablePath: process.env.HEARTH_E2E_CHROME } : {},
);
const context = await browser.newContext({
  serviceWorkers: "block",
  viewport: { width: 1440, height: 900 },
});
const problems: string[] = [];
context.on("weberror", (e) => problems.push(`page error: ${e.error().message}`));
try {
  const home = await context.newPage();
  await home.goto(base);
  await home.getByRole("heading", { name: "Inbox" }).waitFor({ timeout: 20_000 });

  await step("a note keeps a keystroke typed as its tab closed", async () => {
    const note = await act<{ id: string }>(home, "note.create", { title: `Plan ${tag}`, body: "" });
    const typed = `Book the flights ${tag}`;
    const p = await killTab(context, {
      path: `/note/${note.id}`,
      ready: (p) => p.locator(".cm-content").waitFor({ timeout: 20_000 }),
      action: "doc.sync",
      edit: async (p) => {
        await p.locator(".cm-content").click();
        await p.keyboard.type(typed);
      },
      saved: async (p) =>
        ((await act<{ body: string }>(p, "entity.get", { id: note.id })).body ?? "").includes(
          typed,
        ),
    });
    await p.getByText(typed).waitFor();
    await p.close();
  });

  await step("a board keeps a card added as its tab closed", async () => {
    const board = await act<{ id: string }>(home, "canvas.create", { title: `Trip ${tag}` });
    const p = await killTab(context, {
      path: `/canvas/${board.id}`,
      ready: (p) => p.locator("[data-toolbar]").waitFor({ timeout: 20_000 }),
      action: "canvas.save",
      edit: async (p) => {
        const area = (await p.locator("[data-toolbar]").locator("..").boundingBox())!;
        await p.mouse.dblclick(area.x + 300, area.y + 300);
        await p.keyboard.type(`Hotel ${tag}`);
        await p.keyboard.press("Escape");
      },
      saved: async (p) =>
        JSON.stringify(
          (await act<{ board: unknown }>(p, "canvas.get", { id: board.id })).board,
        ).includes(`Hotel ${tag}`),
    });
    await p.getByText(`Hotel ${tag}`).waitFor();
    await p.close();
  });

  await step("a spreadsheet keeps a cell typed as its tab closed", async () => {
    const sheet = await act<{ id: string }>(home, "sheet.create", { title: `Budget ${tag}` });
    const p = await killTab(context, {
      path: `/sheet/${sheet.id}`,
      ready: (p) => p.locator('[data-cell="A1"]').waitFor({ timeout: 20_000 }),
      action: "sheet.save",
      edit: async (p) => {
        await p.locator('[data-cell="B2"]').click();
        await p.keyboard.type("1250");
        await p.keyboard.press("Enter");
      },
      saved: async (p) => {
        const got = await act<{ book: { sheets: { cells: Record<string, string> }[] } }>(
          p,
          "sheet.get",
          { id: sheet.id },
        );
        return got.book.sheets[0]?.cells.B2 === "1250";
      },
    });
    await p.close();
  });

  await step("meeting notes keep a line typed as the tab closed", async () => {
    const meeting = await act<{ id: string }>(home, "meeting.start", { title: `Sync ${tag}` });
    const typed = `Ship on Friday ${tag}`;
    const p = await killTab(context, {
      path: `/record/${meeting.id}`,
      ready: (p) =>
        p.getByPlaceholder("What matters in this meeting…").waitFor({ timeout: 20_000 }),
      action: "meeting.update",
      edit: async (p) => {
        await p.getByPlaceholder("What matters in this meeting…").click();
        await p.keyboard.type(typed);
      },
      saved: async (p) =>
        (await act<{ notes: string }>(p, "meeting.get", { id: meeting.id })).notes.includes(typed),
    });
    const box = p.getByPlaceholder("What matters in this meeting…");
    if (!(await box.inputValue()).includes(typed)) throw new Error("the notes box lost the line");
    await p.close();
  });

  await step("a board edit made while Jarvis adds a card keeps both", async () => {
    const board = await act<{ id: string }>(home, "canvas.create", { title: `Both ${tag}` });
    const p = await context.newPage();
    await p.goto(`${base}/canvas/${board.id}`);
    await p.locator("[data-toolbar]").waitFor({ timeout: 20_000 });
    const release = await hold(context, "canvas.save");
    const area = (await p.locator("[data-toolbar]").locator("..").boundingBox())!;
    await p.mouse.dblclick(area.x + 300, area.y + 300);
    await p.keyboard.type(`Mine ${tag}`);
    await p.keyboard.press("Escape");
    // Jarvis's card lands while this screen's save is held up.
    await act(p, "canvas.add", {
      id: board.id,
      cards: [{ text: `Jarvis ${tag}` }],
    });
    await release();
    // The held save is lost; the next one is refused as stale, merged, and saved again.
    await p.mouse.dblclick(area.x + 300, area.y + 500);
    await p.keyboard.type(`More ${tag}`);
    await p.keyboard.press("Escape");
    // Up to 10 s for the held save to time out, then the retry, the merge and the save.
    for (let i = 0; i < 125; i++) {
      const saved = JSON.stringify(
        (await act<{ board: unknown }>(p, "canvas.get", { id: board.id })).board,
      );
      if ([`Mine ${tag}`, `Jarvis ${tag}`, `More ${tag}`].every((s) => saved.includes(s))) {
        await p.getByText(`Jarvis ${tag}`).waitFor();
        await p.close();
        return;
      }
      await p.waitForTimeout(200);
    }
    throw new Error("a card was lost");
  });

  await step("a note deleted while open goes read-only until it's restored", async () => {
    const note = await act<{ id: string }>(home, "note.create", { title: `Gone ${tag}`, body: "" });
    const p = await context.newPage();
    await p.goto(`${base}/note/${note.id}`);
    const editor = p.locator(".cm-content");
    await editor.waitFor({ timeout: 20_000 });
    await act(p, "entity.trash", { id: note.id });
    await editor.click();
    await p.keyboard.type("typed after it went");
    await p.getByText("This was deleted before your last changes reached Hearth").waitFor();
    await p.getByRole("button", { name: "Copy text" }).waitFor();
    if ((await editor.getAttribute("contenteditable")) !== "false")
      throw new Error("the deleted note can still be edited");
    // Restored, it takes edits again, and what was typed while it was gone reaches Hearth too.
    await p.getByRole("button", { name: "Restore", exact: true }).click();
    await p.locator('.cm-content[contenteditable="true"]').waitFor();
    await editor.click();
    await p.keyboard.press("End");
    await p.keyboard.type(" and back");
    for (let i = 0; ; i++) {
      const { body } = await act<{ body: string | null }>(p, "entity.get", { id: note.id });
      if (body?.startsWith("t") && body.endsWith(" and back")) break;
      if (i === 50) throw new Error("the restored note didn't save what was typed in it");
      await p.waitForTimeout(200);
    }
    await p.close();
  });

  await step("a note opened from the trash opens once it's restored", async () => {
    const note = await act<{ id: string }>(home, "note.create", { title: `Bin ${tag}`, body: "" });
    await act(home, "entity.trash", { id: note.id });
    // Never opened in this browser, so there's no copy of it here to read.
    const p = await context.newPage();
    await p.goto(`${base}/note/${note.id}`);
    await p.getByText("there's no copy of it on this device").waitFor({ timeout: 20_000 });
    if (await p.getByText("Couldn't open this note").count())
      throw new Error("a note in the trash says Hearth isn't running");
    await p.getByRole("button", { name: "Restore", exact: true }).click();
    const editor = p.locator('.cm-content[contenteditable="true"]');
    await editor.waitFor();
    await editor.click();
    await p.keyboard.type("back from the bin");
    for (let i = 0; ; i++) {
      const { body } = await act<{ body: string | null }>(p, "entity.get", { id: note.id });
      if (body === "back from the bin") break;
      if (i === 50) throw new Error("the note restored after it opened didn't save");
      await p.waitForTimeout(200);
    }
    await p.close();
  });

  if (problems.length) throw new Error(problems.join("\n"));
  console.log("Integrity checks passed.");
} finally {
  await browser.close();
  await stop();
}
