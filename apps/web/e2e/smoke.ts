// End-to-end check of the web app in a real browser, against a running Hearth server:
// passkey setup and sign-in (with a virtual authenticator), tasks, a live note that @mentions a task
// and syncs to a second window, backlinks, subtasks, Cmd+K with split panes, chatting with Jarvis,
// memory, and the pause switch.
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

const browser = await chromium.launch({
  ...(process.env.HEARTH_E2E_CHROME ? { executablePath: process.env.HEARTH_E2E_CHROME } : {}),
  // A pretend microphone for Talk.
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const problems: string[] = [];
page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
// Requests sent while the test is signed out are expected to get 401, so they aren't problems.
let signedOut = false;
const whileSignedOut = new WeakSet<object>();
page.on("request", (req) => {
  if (signedOut) whileSignedOut.add(req);
});
page.on("response", async (r) => {
  if (r.status() === 401 && whileSignedOut.has(r.request())) return;
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

  await step("a live note that @mentions a task", async (p) => {
    await keys("Escape");
    await p.locator("nav").click({ position: { x: 100, y: 600 } });
    await keys("g", "n");
    await p.getByRole("button", { name: "New note" }).click();
    const title = p.locator("input[placeholder=Untitled]");
    await title.fill(`Monthly money ${tag}`);
    await title.press("Enter");
    const editor = p.locator(".cm-content");
    await editor.click();
    await editor.pressSequentially(`Remember to @Pay rent ${tag}`);
    await p
      .locator(".cm-tooltip-autocomplete li", { hasText: `Pay rent ${tag}` })
      .first()
      .click();
    await editor.pressSequentially(" before Friday.\n- [ ] cancel the gym");
    await editor.locator("span", { hasText: `@Pay rent ${tag}` }).waitFor();
    await editor.locator("input[type=checkbox]").waitFor();
    await p.waitForTimeout(1500);
    if (await p.getByText("Not saved yet").count()) throw new Error("the note didn't save");
  });

  await step("the note syncs live to another window", async (p) => {
    const other = await context.newPage();
    await other.goto(p.url());
    const there = other.locator(".cm-content");
    await there.getByText("cancel the gym").waitFor();
    await there.click();
    await other.keyboard.press("Control+End");
    await other.keyboard.type("\nAdded from the other window");
    await p
      .locator(".cm-content")
      .getByText("Added from the other window")
      .waitFor({ timeout: 10_000 });
    await other.close();
  });

  await step("a checkpoint in the note's history, restored after an edit", async (p) => {
    await p.getByRole("button", { name: "History" }).click();
    await p.getByRole("button", { name: "Save as checkpoint" }).click();
    await p.getByPlaceholder("Name this version").fill("Before scratch");
    await keys("Enter");
    await p.getByRole("button", { name: "Before scratch" }).waitFor();
    await p.getByRole("button", { name: "Back to editing" }).click();
    const editor = p.locator(".cm-content");
    await editor.getByText("cancel the gym").waitFor();
    await editor.click();
    await keys("Control+End");
    await p.keyboard.type("\nScratch line");
    await p.waitForTimeout(1500);
    await p.getByRole("button", { name: "History" }).click();
    await p.getByRole("button", { name: "Before scratch" }).click();
    const preview = p.locator("section[aria-label=History] pre");
    await preview.getByText("cancel the gym").waitFor();
    if ((await preview.innerText()).includes("Scratch line")) throw new Error("wrong version");
    await p.getByRole("button", { name: "Restore this version" }).click();
    await editor.getByText("cancel the gym").waitFor();
    await editor.getByText("Scratch line").waitFor({ state: "detached" });
  });

  await step("the task lists the note as a backlink, and takes a subtask", async (p) => {
    // The status line moves while the other window's edit lands, so a mouse click can miss;
    // the chip opens on mousedown.
    await p.locator(".cm-content span", { hasText: `@Pay rent ${tag}` }).dispatchEvent("mousedown");
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

  await step("a canvas board with a sticky, a box, an arrow and a task card", async (p) => {
    await p.goto(`${base}/canvases`);
    await p.getByRole("heading", { name: "Canvas" }).waitFor();
    await p.getByRole("button", { name: "New board" }).click();
    // Name it once the board has loaded (loading sets the name it came with).
    await p.locator("[data-toolbar]").waitFor();
    const name = p.getByLabel("Board name");
    await name.fill(`Trip plan ${tag}`);
    await name.press("Enter");
    const board = p.locator("[data-toolbar]").locator("..");
    const box = (await board.boundingBox())!;
    await p.mouse.dblclick(box.x + 200, box.y + 250);
    await p.keyboard.type(`Book flights ${tag}`);
    await keys("Escape");
    await p.getByTitle("Box (R)").click();
    await p.mouse.click(box.x + 600, box.y + 250);
    await p.keyboard.type("Hotel");
    await keys("Escape");
    await p.getByTitle("Arrow (A)").click();
    await p.mouse.move(box.x + 200, box.y + 250);
    await p.mouse.down();
    await p.mouse.move(box.x + 400, box.y + 250, { steps: 5 });
    await p.mouse.move(box.x + 600, box.y + 250, { steps: 5 });
    await p.mouse.up();
    await p.getByRole("button", { name: "@ Record" }).click();
    await p.getByLabel("Find a record").fill(`Pay rent ${tag}`);
    await p.getByRole("button", { name: new RegExp(`Pay rent ${tag}`) }).click();
    await p.waitForTimeout(1500);
    const id = new URL(p.url()).pathname.split("canvas/")[1]!.split("+")[0]!;
    const saved = await p.evaluate(async (id) => {
      const r = await fetch("/api/actions/canvas.get", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      type Saved = {
        title: string;
        board: {
          nodes: { type: string }[];
          edges: { from: { type: string }; to: { type: string } }[];
        };
      };
      return ((await r.json()) as { result: Saved }).result;
    }, id);
    const kinds = saved.board.nodes
      .map((n: { type: string }) => n.type)
      .sort()
      .join(",");
    if (saved.title !== `Trip plan ${tag}`) throw new Error(`board named ${saved.title}`);
    if (kinds !== "entitymention,shape,text") throw new Error(`board holds ${kinds}`);
    const edge = saved.board.edges[0];
    if (edge?.from.type !== "connected" || edge?.to.type !== "connected")
      throw new Error(`arrow ${JSON.stringify(saved.board.edges)}`);
    await p.reload();
    await p.getByText(`Book flights ${tag}`).waitFor();
  });

  await step("a message to Jarvis", async (p) => {
    await p.locator("aside textarea").fill(`Hello ${tag}`);
    await p.locator("aside").getByRole("button", { name: "Send" }).click();
    await p.locator("aside .ml-8", { hasText: `Hello ${tag}` }).waitFor();
  });

  await step("something for Jarvis to remember, changed and put back", async (p) => {
    await p.locator("nav").click({ position: { x: 100, y: 600 } });
    await keys("g", "m");
    await p.getByRole("heading", { name: "Memory" }).waitFor();
    await p.getByPlaceholder("Add something for Jarvis to remember…").fill(`Coffee ${tag}`);
    await keys("Enter");
    // The text is a live doc, saved as you type.
    const editor = p.locator(".cm-content");
    await editor.click();
    await p.keyboard.type("Oat flat white.");
    await p.waitForTimeout(1500);
    await p.getByRole("button", { name: "in every answer" }).click();
    await p.getByText("Earlier versions").waitFor();
    await p.locator("li", { hasText: "Oat flat white." }).first().waitFor();
    await p.getByRole("button", { name: "Go back to this" }).last().click();
    await p.getByText("Back to version 1.").waitFor();
    await editor.getByText("Oat flat white.").waitFor({ state: "detached" });
  });

  await step("dictation cleaned with your dictionary, in the voice history", async (p) => {
    await p.locator("nav").click({ position: { x: 100, y: 600 } });
    await keys("g", "v");
    await p.getByRole("heading", { name: "Voice" }).waitFor();
    await p.getByRole("tab", { name: "Dictionary" }).click();
    await p.getByPlaceholder("When it hears… (optional)").fill("auto pair");
    await p.getByPlaceholder("Write it as").fill(`OtoPair${tag}`);
    await keys("Enter");
    await p.getByText(`OtoPair${tag}`).waitFor();
    // What the desktop app sends when you let go of the hotkey.
    const status = await p.evaluate(async () => {
      const r = await fetch("/api/actions/voice.clean", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ raw: "um open auto pair please", app: "notepad.exe" }),
      });
      return r.status;
    });
    if (status !== 200) throw new Error(`voice.clean answered ${status}`);
    await p.getByRole("tab", { name: "History" }).click();
    await p.getByText(`Open OtoPair${tag} please`).waitFor();
    await p.getByRole("tab", { name: "Voice samples" }).click();
    await p.getByText(`Can you send the OtoPair${tag} update to the team today?`).waitFor();
  });

  await step("the calendar, mail, Google, Slack and GitHub in Settings", async (p) => {
    await p.locator("nav").click({ position: { x: 100, y: 600 } });
    await keys("g", "c");
    await p.getByRole("heading", { name: "Calendar" }).waitFor();
    await keys("g", "e");
    await p.getByRole("heading", { name: "Mail" }).waitFor();
    await p.getByText("Connect Gmail in Settings").waitFor();
    await keys("g", "s");
    await p.getByRole("heading", { name: "Google" }).waitFor();
    await p.getByRole("heading", { name: "Slack" }).waitFor();
    const create = p.getByRole("link", { name: "Create Hearth's Slack app" });
    if (!(await create.getAttribute("href"))?.includes("search%3Aread"))
      throw new Error("the Slack app link doesn't ask for its scopes");
    await p.getByRole("heading", { name: "GitHub" }).waitFor();
    await p.getByRole("link", { name: "Make a read-only token" }).waitFor();
  });

  await step("pair the desktop app, whose code runs only voice actions", async (p) => {
    await p.getByRole("button", { name: "Pair the desktop app" }).click();
    const code = (await p.locator("code.truncate").last().textContent()) ?? "";
    // Sent from outside the page, as the desktop app would.
    const asDevice = async (name: string) =>
      (
        await fetch(`${base}/api/actions/${name}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${code}` },
          body: JSON.stringify({ raw: "um hi", save: false }),
        })
      ).status;
    if ((await asDevice("voice.clean")) !== 200) throw new Error("the desktop code can't dictate");
    if ((await asDevice("task.list")) !== 403) throw new Error("the desktop code can do too much");
    await p.getByRole("button", { name: "Unpair" }).last().click();
    await p.getByRole("button", { name: "Pair the desktop app" }).waitFor();
  });

  await step("a sign-in for Jarvis and a routine, in Settings", async (p) => {
    await p.getByLabel("Site").fill("example.com");
    await p.getByLabel("Username").fill("me@example.com");
    await p.getByLabel("Password", { exact: true }).fill("smoke-test-password");
    await p.getByRole("button", { name: "Save sign-in" }).click();
    await p.getByText("not used yet").waitFor();
    await p.getByLabel("Routine name").fill("Smoke routine");
    await p.getByLabel("What to do").fill("Check the weather and tell me.");
    await p.getByRole("button", { name: "Add routine" }).click();
    await p.getByText("weekdays at 7 a.m.").first().waitFor();
  });

  await step("sign out and back in with the passkey", async (p) => {
    signedOut = true;
    await p.getByRole("button", { name: "Sign out" }).click();
    await p.getByRole("button", { name: "Sign in with your passkey" }).click();
    await p.getByRole("button", { name: "Sign out" }).waitFor();
    signedOut = false;
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

  await step(
    "on a phone: one pane, a tab bar, Jarvis full screen, the phone settings",
    async (p) => {
      await p.setViewportSize({ width: 390, height: 844 });
      const tabs = p.locator("nav").last();
      await tabs.getByRole("button", { name: "Tasks" }).click();
      await p.getByRole("heading", { name: "Tasks" }).waitFor();
      await p.getByText(`Pack for the trip ${tag}`).first().click();
      // The task fills the screen; closing it goes back to the list.
      await p.getByTitle("Close pane (Alt+W)").click();
      await p.getByRole("heading", { name: "Tasks" }).waitFor();
      await tabs.getByRole("button", { name: "Jarvis", exact: true }).click();
      await p.locator("aside").getByText("Jarvis", { exact: true }).waitFor();
      // Talk from the tab bar: Jarvis opens listening; the second tap sends what the PC heard.
      await p.route("**/api/voice/transcribe", (r) =>
        r.fulfill({ json: { text: `What is on today ${tag}` } }),
      );
      await tabs.getByRole("button", { name: "Talk to Jarvis" }).click();
      await p.waitForTimeout(1500);
      await tabs.getByRole("button", { name: "Stop and send" }).click();
      await p.locator("aside").getByText(`What is on today ${tag}`).first().waitFor();
      await p.unroute("**/api/voice/transcribe");
      await tabs.getByRole("button", { name: "More" }).click();
      await p.getByRole("button", { name: "Settings" }).click();
      await p.getByRole("heading", { name: "Phone" }).waitFor();
    },
  );
} finally {
  await browser.close();
}

if (problems.length) {
  console.error(`Problems:\n${problems.join("\n")}`);
  process.exit(1);
}
console.log("All good.");
