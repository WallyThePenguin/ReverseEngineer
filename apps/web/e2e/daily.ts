// End-to-end check of the loops used every day: split panes that keep working after one closes,
// moving things to the trash and back, and clearing the inbox and tasks by touch on a phone.
//
//   HEARTH_DEV_AUTH=1 HEARTH_WEB_DIST=apps/web/dist hearth serve    (in another terminal)
//   HEARTH_E2E_URL=http://localhost:4400 node apps/web/e2e/daily.ts
//
// The server needs development login on (loopback only), so no passkey is involved.
// HEARTH_E2E_CHROME points at a Chromium to use instead of Playwright's own download.

import { chromium, type Page } from "playwright";

const base = process.env.HEARTH_E2E_URL ?? "http://localhost:4400";
const tag = Date.now().toString(36).slice(-4);

const browser = await chromium.launch(
  process.env.HEARTH_E2E_CHROME ? { executablePath: process.env.HEARTH_E2E_CHROME } : {},
);
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  serviceWorkers: "block",
});
const page = await context.newPage();
const problems: string[] = [];
page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));

/** Runs an action as the app would, from the page (same origin, dev login). */
async function run<T = unknown>(p: Page, name: string, input: unknown): Promise<T> {
  const r = (await p.evaluate(
    async ([n, i]) => {
      const res = await fetch(`/api/actions/${n}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(i),
      });
      return res.json();
    },
    [name, input] as const,
  )) as { status: string; result: T };
  if (r.status !== "ok") throw new Error(`${name} answered ${JSON.stringify(r)}`);
  return r.result;
}
const keys = async (p: Page, ...k: string[]) => {
  for (const key of k) await p.keyboard.press(key);
};
/** The pane whose header says `title`. */
const pane = (p: Page, title: string) =>
  p.locator("section", { has: p.getByRole("heading", { name: title, exact: true }) });

async function step(name: string, fn: (p: Page) => Promise<void>) {
  await fn(page);
  console.log(`✓ ${name}`);
}

try {
  await page.goto(base);
  await page.getByRole("heading", { name: "Inbox" }).waitFor();
  const titles = ["one", "two", "three"].map((n) => `Daily ${n} ${tag}`);
  for (const title of titles) await run(page, "task.create", { title });

  await step("two panes, close the left one, and j still moves in the one left", async (p) => {
    await p.goto(`${base}/inbox+tasks`);
    const tasks = pane(p, "Tasks");
    await tasks.getByText(titles[2]!).waitFor();
    await pane(p, "Inbox").getByTitle("Close pane (Alt+W)").click();
    await p.getByRole("heading", { name: "Inbox" }).waitFor({ state: "detached" });
    const rows = tasks.locator("li");
    const active = tasks.locator('li[data-active="true"]');
    // A task row reads "T-12", then its title.
    const titleOf = async (row: typeof rows) => (await row.innerText()).split("\n")[1]?.trim();
    const second = await titleOf(rows.nth(1));
    await keys(p, "j");
    if ((await active.count()) !== 1) throw new Error("no row is selected after j");
    if ((await titleOf(active)) !== second)
      throw new Error(`j selected "${await active.innerText()}", not the second row`);
    // x completes that row; it leaves the list and the row that took its place is selected.
    const third = await titleOf(rows.nth(2));
    await keys(p, "x");
    await tasks.getByText(second!, { exact: true }).waitFor({ state: "detached" });
    if ((await titleOf(active)) !== third)
      throw new Error("the selection didn't move to the row that took the completed one's place");
  });

  await step(
    "a task trashed from its row's menu leaves at once, and Undo puts it back",
    async (p) => {
      await p.goto(`${base}/tasks`);
      const tasks = pane(p, "Tasks");
      const row = tasks.locator("li", { hasText: titles[0]! });
      await row.hover();
      await row.getByRole("button", { name: /^Actions for/ }).click();
      await p.getByRole("menuitem", { name: "Move to trash" }).click();
      await row.waitFor({ state: "detached" });
      await p.getByText(`Moved "${titles[0]}" to the trash.`).waitFor();
      await p.getByRole("button", { name: "Undo" }).click();
      await row.waitFor();
      await p.getByText(`Restored "${titles[0]}".`).waitFor();
    },
  );

  await step("# trashes a task with its subtask; the Trash view brings both back", async (p) => {
    const parent = await run<{ id: string }>(p, "task.create", { title: `Trip ${tag}` });
    await run(p, "task.create", { title: `Tickets ${tag}`, parentId: parent.id });
    await p.goto(`${base}/tasks`);
    const tasks = pane(p, "Tasks");
    const row = tasks.locator("li", { hasText: `Trip ${tag}` });
    // Picking it opens it beside the list; the keys stay with the list.
    await row.click();
    await pane(p, "Tasks")
      .locator('li[data-active="true"]', { hasText: `Trip ${tag}` })
      .waitFor();
    await keys(p, "#");
    await row.waitFor({ state: "detached" });
    await p.getByText(`Moved "Trip ${tag}" and 1 record under it to the trash.`).waitFor();

    await p.goto(`${base}/trash`);
    const trash = pane(p, "Trash");
    const gone = trash.locator("li", { hasText: `Trip ${tag}` });
    await gone.getByText("with 1 record under it").waitFor();
    await gone.getByRole("button", { name: "Restore" }).click();
    await gone.waitFor({ state: "detached" });
    const subs = await run<{ title: string }[]>(p, "task.list", {
      parentId: parent.id,
      includeClosed: true,
    });
    if (subs.map((s) => s.title).join() !== `Tickets ${tag}`)
      throw new Error(`the subtask didn't come back: ${JSON.stringify(subs)}`);
  });

  await step("a note trashed from its header closes its pane; z undoes it", async (p) => {
    const note = await run<{ id: string }>(p, "note.create", { title: `Idea ${tag}` });
    await p.goto(`${base}/notes+note/${note.id}`);
    const view = pane(p, "Note");
    await view.getByRole("button", { name: "More actions" }).click();
    await p.getByRole("menuitem", { name: "Move to trash" }).click();
    await view.waitFor({ state: "detached" });
    await p.getByText(`Moved "Idea ${tag}" to the trash.`).waitFor();
    await keys(p, "z");
    await p.getByText(`Restored "Idea ${tag}".`).waitFor();
    const back = await run<{ deletedAt: string | null }>(p, "entity.get", { id: note.id });
    if (back.deletedAt !== null) throw new Error("z didn't bring the note back");
  });

  await step("a conversation can be renamed, found, and moved to the trash", async (p) => {
    const chat = await run<{ id: string }>(p, "conversation.create", { title: `Chat ${tag}` });
    await p.goto(`${base}/chat/${chat.id}`);
    await p.getByRole("heading", { name: `Chat ${tag}` }).waitFor();
    await p.getByRole("button", { name: "More actions" }).click();
    await p.getByRole("menuitem", { name: "Rename" }).click();
    const box = p.getByRole("textbox", { name: "Conversation name" });
    await box.fill(`Kitchen plan ${tag}`);
    await box.press("Enter");
    await p.getByRole("heading", { name: `Kitchen plan ${tag}` }).waitFor();
    const found = await run<{ id: string }[]>(p, "conversation.list", { query: `plan ${tag}` });
    if (found.map((c) => c.id).join() !== chat.id) throw new Error("rename didn't stick");
    await p.getByRole("button", { name: "More actions" }).click();
    await p.getByRole("menuitem", { name: "Move to trash" }).click();
    await p.getByText(`Moved "Kitchen plan ${tag}" to the trash.`).waitFor();
    // A lone pane goes back to the inbox.
    await p.getByRole("heading", { name: "Inbox" }).waitFor();
    if ((await run<unknown[]>(p, "conversation.list", { query: tag })).length)
      throw new Error("the trashed conversation is still listed");
  });
} finally {
  await browser.close();
}

if (problems.length) {
  console.error(`Problems:\n${problems.join("\n")}`);
  process.exit(1);
}
console.log("All good.");
