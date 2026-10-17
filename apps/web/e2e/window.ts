// End-to-end check of Hearth's window on this PC signing itself in with Windows Hello (D69). The
// window opens Hearth at http://localhost:<port>, where passkeys made at Hearth's own https address
// can't work. Chromium's virtual authenticator stands in for Windows Hello, and the user agent is
// the app's. Runs its own server on HEARTH_E2E_PORT against HEARTH_DATABASE_URL, with Hearth's own
// address an https one no browser here opens: first with the development login, to add your
// passkey there (a software one, as Tailscale Serve would bring it), connect the app, and add the
// window's passkey in Settings as you would once signed in; then without, to sign in with it.
//
//   pnpm build:web
//   HEARTH_DATABASE_URL=postgres://... HEARTH_E2E_PORT=4404 node apps/web/e2e/window.ts
//
// HEARTH_E2E_CHROME points at a Chromium to use instead of Playwright's own download.

import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { SoftAuthenticator } from "../../server/src/testing/authenticator.ts";
import { home } from "./home.ts";

const port = Number(process.env.HEARTH_E2E_PORT ?? 4404);
const base = `http://localhost:${port}`;
const OWN = "https://hearth.example.test";
const repo = join(import.meta.dirname, "../../..");
if (!process.env.HEARTH_DATABASE_URL) throw new Error("Set HEARTH_DATABASE_URL.");

let hearth: ChildProcess | null = null;
async function start(devAuth: boolean) {
  hearth = spawn(process.execPath, [join(repo, "apps/cli/src/main.ts"), "serve"], {
    cwd: repo,
    windowsHide: true,
    env: {
      ...process.env,
      HEARTH_WEB_DIST: join(repo, "apps/web/dist"),
      HEARTH_DEV_AUTH: devAuth ? "1" : "",
      HEARTH_PORT: String(port),
      HEARTH_ORIGIN: OWN,
      // Hearth's address on this PC, the window's: http://localhost:<port>.
      HEARTH_LOCAL_ORIGIN: "",
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
  const limit = new Promise<"hung">((r) => setTimeout(() => r("hung"), 20_000).unref());
  if ((await Promise.race([exited, limit])) === "hung") {
    h.kill("SIGKILL");
    throw new Error("Hearth didn't stop within 20 s of being asked");
  }
}

async function step(name: string, fn: () => Promise<void>) {
  await fn();
  console.log(`✓ ${name}`);
}

const browser = await chromium.launch(
  process.env.HEARTH_E2E_CHROME ? { executablePath: process.env.HEARTH_E2E_CHROME } : {},
);
// The app's window says so in its user agent (lib/desktop.ts).
const context = await browser.newContext({
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 HearthDesktop/1.0.21",
});
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send("WebAuthn.enable");
const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: {
    protocol: "ctap2",
    transport: "internal",
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
  },
});
const hello = (verified: boolean) =>
  cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: verified });
// The window never connects itself: only your click in Settings does.
const handoffs: string[] = [];
context.on("request", (r) => {
  if (r.url().includes("/api/auth/desktop/handoff")) handoffs.push(r.url());
});
const noDeadButton = async (p: Page) => {
  if (await p.getByRole("button", { name: "Sign in with your passkey" }).count())
    throw new Error("the passkey button that can't work here is shown");
};
const noHello = async (p: Page) => {
  if (await p.getByRole("button", { name: "Sign in with Windows Hello" }).count())
    throw new Error("Windows Hello is offered where it would sign the window out");
};

/** Your first passkey, at Hearth's own address: the window's can only follow one. */
async function ownPasskey() {
  const key = new SoftAuthenticator(OWN);
  const post = (path: string, body: unknown, cookie = "") =>
    fetch(`${base}/api/auth/${path}`, {
      method: "POST",
      headers: {
        origin: OWN,
        "x-forwarded-host": new URL(OWN).host,
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify(body),
    });
  const options = await post("register/options", {});
  const cookie = options.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const verify = await post(
    "register/verify",
    { response: key.register((await options.json()) as { challenge: string }), label: "Laptop" },
    cookie,
  );
  if (!verify.ok) throw new Error(`your passkey wasn't added: ${await verify.text()}`);
}

try {
  await step("signed in, the window adds its own Windows Hello passkey in Settings", async () => {
    await start(true);
    await ownPasskey();
    await page.goto(`${base}/settings`);
    // Connected, as Connect Hearth on this PC leaves it.
    const paired = await page.evaluate(() =>
      fetch("/api/devices/desktop/pair", { method: "POST" }).then((r) => r.ok),
    );
    if (!paired) throw new Error("the desktop app couldn't be connected");
    await page.getByRole("button", { name: "Add a passkey for this PC's Nook window" }).click();
    await page.getByText("Windows Hello is set up").waitFor();
    await page.getByText("Works in Nook's window on this PC").first().waitFor();
  });

  await step("its sign-in page's link opens Desktop app and says why, nothing more", async () => {
    await page.goto(`${base}/settings?connect=desktop`);
    await page.getByText("If Nook's window on this PC asked you to sign in again").waitFor();
    await page.getByRole("button", { name: "Connect Nook on this PC" }).waitFor();
    if (new URL(page.url()).search) throw new Error(`the address kept ${page.url()}`);
    await page.waitForTimeout(500);
    if (handoffs.length) throw new Error("the link connected the window by itself");
  });

  await step("signed out, the window offers Windows Hello", async () => {
    await stop();
    await start(false);
    await page.goto(base);
    await page.getByRole("button", { name: "Sign in with Windows Hello" }).waitFor();
    await noDeadButton(page);
  });

  await step("Windows Hello not finishing offers your browser too", async () => {
    await hello(false);
    await page.getByRole("button", { name: "Sign in with Windows Hello" }).click();
    await page.getByRole("button", { name: "Connect in your browser" }).waitFor();
    await page.getByText(/^Windows Hello (was closed|didn't work here)/).waitFor();
    await hello(true);
  });

  await step("Windows Hello signs the window in", async () => {
    await page.getByRole("button", { name: "Sign in with Windows Hello" }).click();
    await home(page).waitFor();
  });

  await step("where no passkey can work, the window is sent to your browser", async () => {
    // At 127.0.0.1 no passkey can be made or used: an address for passkeys is a name.
    const other = await context.newPage();
    await other.route(`${OWN}/**`, (r) => r.fulfill({ body: "Hearth" }));
    await other.goto(`http://127.0.0.1:${port}/`);
    const connect = other.getByRole("button", { name: "Connect in your browser" });
    await connect.waitFor();
    await noDeadButton(other);
    const sent = other.waitForRequest((r) => r.url().startsWith(`${OWN}/settings?connect=desktop`));
    await connect.click();
    await sent;
    await other.close();
  });

  await step("Chrome or Edge at the window's address is sent to Hearth's own", async () => {
    // Windows shares Windows Hello's passkeys with them, but signing in here would sign the
    // window out.
    const chrome = await browser.newContext();
    const other = await chrome.newPage();
    await other.route(`${OWN}/**`, (r) => r.fulfill({ body: "Hearth" }));
    await other.goto(base);
    await other.getByText(`Nook's address for browsers is ${OWN}`).waitFor();
    await noHello(other);
    await noDeadButton(other);
    // Nor does Hearth make or take the window's passkeys for it.
    const rpId = await other.evaluate(() =>
      fetch("/api/auth/login/options", { method: "POST" })
        .then((r) => r.json() as Promise<{ rpId?: string }>)
        .then((o) => o.rpId),
    );
    if (rpId !== new URL(OWN).hostname) throw new Error(`Chrome here was given ${rpId}'s passkeys`);
    const sent = other.waitForRequest((r) => r.url() === `${OWN}/`);
    await other.getByRole("button", { name: "Go to Nook's address" }).click();
    await sent;
    await chrome.close();
  });

  await step("disconnected, the window's passkey no longer signs it in", async () => {
    await page.goto(`${base}/settings?connect=desktop`);
    // The desktop app's row, by its Connect button: other places can have a Disconnect too.
    const row = page.getByRole("button", { name: "Connect Nook on this PC" }).locator("xpath=..");
    // Still signed in when you click: nothing before this signed the window out.
    const disconnected = page.waitForResponse(
      (r) => r.url().endsWith("/api/devices/desktop") && r.request().method() === "DELETE",
    );
    await row.getByRole("button", { name: "Disconnect" }).click();
    const status = (await disconnected).status();
    if (status !== 200) throw new Error(`Disconnect was answered ${status}`);
    // Disconnect signs the window out too (D53), this one included: it goes straight to its
    // sign-in page, which offers only your browser, and its toast goes with the rest of the app.
    const connect = page.getByRole("button", { name: "Connect in your browser" });
    await connect.waitFor();
    await noHello(page);
    // And it stays that way.
    await page.goto(base);
    await connect.waitFor();
    await noHello(page);
    await noDeadButton(page);
  });

  console.log("Window sign-in checks passed.");
} finally {
  await browser.close();
  await stop();
}
