// Smoke steps for a title you're typing while the record changes elsewhere, run from smoke.ts
// right after the subtask step (they start on the task that took the subtask).
//
// Jarvis (or another screen) changes the record after you've typed a new title but before you
// press Enter. Showing that change reads the record again; what you typed must stay, and Enter
// must save it. On a slow PC the note's own "created" event brings the same read just as you
// start typing its title.
import type { Locator, Page } from "playwright";

interface Smoke {
  step: (name: string, fn: (p: Page) => Promise<void>) => Promise<void>;
  keys: (...k: string[]) => Promise<void>;
  tag: string;
}

/** Runs an action as this page's signed-in owner: a change made somewhere else. */
const elsewhere = (p: Page, name: string, input: object) =>
  p.evaluate(
    async ([n, i]) => {
      await fetch(`/api/actions/${n}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(i),
      });
    },
    [name, input] as const,
  );

/** Types a title, lets `change` land, then presses Enter and waits for the title to be saved. */
async function retitle(
  p: Page,
  title: Locator,
  typed: string,
  save: string,
  change: () => Promise<void>,
) {
  await title.fill(typed);
  await change();
  const saved = p.waitForResponse(
    (r) => r.url().endsWith(`/${save}`) && !!r.request().postData()?.includes(typed),
  );
  await title.press("Enter");
  await saved;
}

const opened = (p: Page) => new URL(p.url()).pathname.split("/")[2]!;

export async function titleSteps({ step, keys, tag }: Smoke) {
  await step("a task's title you're typing stays while the task changes elsewhere", async (p) => {
    const parent = opened(p);
    await p.locator("section li", { hasText: "Set up autopay" }).click();
    await p.waitForURL((u) => !u.pathname.includes(parent));
    const id = opened(p);
    await retitle(
      p,
      p.locator("section input.text-xl"),
      `Autopay ${tag}`,
      "task.update",
      async () => {
        await elsewhere(p, "task.update", { id, body: "From the joint account." });
        await p.getByText("From the joint account.").waitFor();
      },
    );
  });

  await step("a note's title you're typing stays while the note changes elsewhere", async (p) => {
    await p.getByRole("navigation", { name: "Places" }).click({ position: { x: 100, y: 600 } });
    await keys("g", "n");
    await p.getByRole("button", { name: "New note" }).click();
    await p.waitForURL(/\/note\//);
    const id = opened(p);
    await retitle(
      p,
      p.locator("input[placeholder=Untitled]"),
      `Packing ${tag}`,
      "note.update",
      async () => {
        await elsewhere(p, "note.update", { id, body: "- [ ] passport" });
        await p.getByRole("button", { name: "Checklist → tasks" }).waitFor();
      },
    );
  });
}
