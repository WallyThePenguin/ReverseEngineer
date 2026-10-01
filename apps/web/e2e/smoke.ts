// End-to-end check of the web app in a real browser, against a running Hearth server:
// passkey setup and sign-in (with a virtual authenticator), tasks, a note that @mentions a task,
// backlinks, subtasks, Cmd+K with split panes, chatting with Jarvis, and the pause switch.
//
//   HEARTH_E2E_URL=http://localhost:4400 HEARTH_E2E_SETUP_CODE=<from hearth setup> \
//     node apps/web/e2e/smoke.ts
//
// HEARTH_E2E_CHROME points at a Chromium to use instead of Playwright's own download.
// HEARTH_E2E_SHOTS saves a screenshot after each step into that folder.

import { chromium, type Page } from "playwright";

const base = process.env.HEARTH_E2E_URL ?? "http://localhost:4400";
const code = process.env.HEARTH_E2E_SETUP_CODE;
if (!code) throw new Error("Set HEARTH_E2E_SETUP_CODE to the code `hearth setup` printed.");
const shots = process.env.HEARTH_E2E_SHOTS;
const tag = Date.now().toString(36).slice(-4);

const browser = await chromium.launch(
  process.env.HEARTH_E2E_CHROME ? { executablePath: process.env.HEARTH_E2E_CHROME } : {},
);
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const problems: string[] = [];
page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
page.on("response", async (r) => {
  if (r.status() >= 400 && r.url().includes("/api/actions/")) {
    problems.push(
      `${r.status()} ${r.url()} ${r.request().postData() ?? ""} -> ${(await r.text().catch(() => "")).slice(0, 200)}`,
    );
  }
});
const cdp = await context.newCDPSession(page);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: {
    protocol: "ctap2",
    transport: "internal",
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
  },
});

let n = 0;
async function step(name: string, fn: (p: Page) => Promise<void>) {
  await fn(page);
  n += 1;
  if (shots) await page.screenshot({ path: `${shots}/${String(n).padStart(2, "0")}.png` });
  console.log(`✓ ${name}`);
}
const keys = async (...k: string[]) => {
  for (const key of k) await page.keyboard.press(key);
};

try {
  await step("first passkey with the setup code", async (p) => {
    await p.goto(base);
    await p.locator("input[autocomplete=one-time-code]").fill(code);
    await p.getByRole("button", { name: "Create passkey" }).click();
    await p.getByRole("heading", { name: "Inbox" }).waitFor();
  });

  await step("tasks, one of them for Jarvis", async (p) => {
    await keys("g", "t");
    await p.getByRole("heading", { name: "Tasks" }).waitFor();
    await keys("c");
    await p.keyboard.type(`Pay rent ${tag}`);
    await keys("Enter");
    await p.getByText(`Pay rent ${tag}`).first().waitFor();
    await p.getByLabel("For Jarvis").check();
    await p.getByPlaceholder("New task… (press c)").fill(`Pack for the trip ${tag}`);
    await keys("Enter");
    await p.getByText(`Pack for the trip ${tag}`).waitFor();
  });

  await step("a note that @mentions a task, saved once", async (p) => {
    await keys("Escape");
    await p.locator("nav").click({ position: { x: 100, y: 600 } });
    await keys("g", "n");
    await p.getByRole("button", { name: "New note" }).click();
    const title = p.locator("input[placeholder=Untitled]");
    await title.fill(`Monthly money ${tag}`);
    await title.press("Enter");
    await p.getByText("Start writing").click();
    const editor = p.getByPlaceholder("Write… type @ to link");
    await editor.pressSequentially(`Remember to @Pay rent ${tag}`);
    await p
      .locator("ul button", { hasText: `Pay rent ${tag}` })
      .first()
      .waitFor();
    await keys("Enter");
    await editor.pressSequentially("before Friday.\n- [ ] cancel the gym");
    await keys("Control+Enter");
    await p.locator("button.mention", { hasText: `@Pay rent ${tag}` }).waitFor();
    await p.waitForTimeout(1000);
    if (await p.getByText("changed since you opened it").count())
      throw new Error("false save conflict");
  });

  await step("the task lists the note as a backlink, and takes a subtask", async (p) => {
    await p.locator("button.mention", { hasText: `@Pay rent ${tag}` }).click();
    const task = p.locator("section", { hasText: "Linked from" });
    await task.getByRole("button", { name: new RegExp(`Monthly money ${tag}`) }).waitFor();
    await task.getByPlaceholder("Add a subtask…").fill("Set up autopay");
    await keys("Enter");
    await task.locator("li", { hasText: "Set up autopay" }).waitFor();
  });

  await step("Cmd+K finds the note and opens it beside", async (p) => {
    await keys("Control+k");
    await p.getByPlaceholder("Search, run a command, or ask Jarvis…").fill(`monthly money ${tag}`);
    await p.locator("[data-active=true]", { hasText: `Monthly money ${tag}` }).waitFor();
    await keys("Shift+Enter");
    await p.locator("section").nth(1).waitFor();
  });

  await step("a message to Jarvis", async (p) => {
    await p.locator("aside textarea").fill(`Hello ${tag}`);
    await p.locator("aside").getByRole("button", { name: "Send" }).click();
    await p.locator("aside .ml-8", { hasText: `Hello ${tag}` }).waitFor();
  });

  await step("sign out and back in with the passkey", async (p) => {
    await p.getByRole("button", { name: "Sign out" }).click();
    await p.getByRole("button", { name: "Sign in with your passkey" }).click();
    await p.getByRole("button", { name: "Sign out" }).waitFor();
  });

  await step("pause and resume Jarvis", async (p) => {
    await keys("g", "s");
    await p.getByRole("heading", { name: "Settings" }).waitFor();
    const pause = p.getByRole("button", { name: "Pause", exact: true });
    const resume = p.getByRole("button", { name: "Resume", exact: true });
    if (await resume.isVisible()) await resume.click();
    await pause.click();
    await p.locator("aside").getByText("Paused").waitFor();
    await resume.click();
    await pause.waitFor();
  });
} finally {
  await browser.close();
}

if (problems.length) {
  console.error(`Problems:\n${problems.join("\n")}`);
  process.exit(1);
}
console.log("All good.");
