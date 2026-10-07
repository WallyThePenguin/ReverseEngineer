// End-to-end check of Hearth's window on this PC signing itself in with Windows Hello (D69). The
// window opens Hearth at http://localhost:<port>, where passkeys made at Hearth's own https address
// can't work. Chromium's virtual authenticator stands in for Windows Hello, and the user agent is
// the app's. Runs its own server on HEARTH_E2E_PORT against HEARTH_DATABASE_URL, with Hearth's own
// address an https one this test never opens: first with the development login, to add the
// window's passkey in Settings as you would once signed in; then without, to sign in with it.
//
//   pnpm build:web
//   HEARTH_DATABASE_URL=postgres://... HEARTH_E2E_PORT=4404 node apps/web/e2e/window.ts
//
// HEARTH_E2E_CHROME points at a Chromium to use instead of Playwright's own download.

import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
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

try {
  await step("signed in, the window adds its own Windows Hello passkey in Settings", async () => {
    await start(true);
    await page.goto(`${base}/settings`);
    await page.getByRole("button", { name: "Add a passkey for this PC's Hearth window" }).click();
    await page.getByText("Windows Hello is set up").waitFor();
    await page.getByText("Works in Hearth's window on this PC").first().waitFor();
  });

  await step("its sign-in page's link opens Desktop app and says why, nothing more", async () => {
    await page.goto(`${base}/settings?connect=desktop`);
    await page.getByText("Hearth's window on this PC asked to be signed in again").waitFor();
    await page.getByRole("button", { name: "Connect Hearth on this PC" }).waitFor();
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

  console.log("Window sign-in checks passed.");
} finally {
  await browser.close();
  await stop();
}
