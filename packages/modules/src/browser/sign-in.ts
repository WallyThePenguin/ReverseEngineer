// Signing in from the vault (D26): Jarvis asks for it, Hearth's code does it. The password is
// decrypted here and typed straight into the password field of the site it belongs to, over
// HTTPS only; the model, the event log and the audit log never see it. Two-factor codes and
// captchas stay with you: the result says the site needs you, and you finish in the live view.
import { randomBytes } from "node:crypto";
import { vaultLogin } from "@hearth/db";
import { type ActionContext, ActionError, defineAction } from "@hearth/kernel";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { assertAllowed, browser, CALLERS } from "./access.ts";
import { afterStep } from "./act.ts";
import type { BrowserClient } from "./client.ts";
import { insertText, pressKey } from "./input.ts";
import { pace } from "./pace.ts";
import { evaluate, findTab, loadTiming, pageCall, pageFunction } from "./page.ts";
import { loginsFor, VAULT_SERVICE, type Vault, type VaultRow } from "./vault.ts";

const LOGIN = pageFunction("./page-login.js", "pageLogin");

interface Found {
  user: boolean;
  pass: boolean;
  code: boolean;
  captcha: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const login = <T>(client: BrowserClient, tabId: number, opts: Record<string, unknown>) =>
  evaluate<T>(client, tabId, pageCall(LOGIN, opts));

/** The tab's site, held to HTTPS, and the saved login that belongs to it. */
async function siteLogin(
  ctx: ActionContext,
  client: BrowserClient,
  tabId: number,
  username: string | undefined,
): Promise<{ host: string; row: VaultRow | null }> {
  const tab = await findTab(client, tabId);
  const url = new URL(await assertAllowed(ctx, tab.url));
  if (url.protocol !== "https:")
    throw new ActionError("forbidden", `${url.host} isn't using HTTPS, so Hearth won't sign in.`);
  const [row] = await loginsFor(ctx.tx, url.hostname, username);
  return { host: url.hostname, row: row ?? null };
}

interface Form {
  tabId: number;
  /** Marks this sign-in's fields; random, so a page can't mark its own in advance. */
  marker: string;
  host: string;
}

/** Puts the cursor in the marked field, on the right site, and types into it. */
async function fill(client: BrowserClient, f: Form, which: "user" | "pass", text: string) {
  const res = await login<{ focused: boolean }>(client, f.tabId, {
    op: "focus",
    which,
    marker: f.marker,
    host: f.host,
  });
  if (!res.focused) throw new ActionError("failed", "The sign-in form changed while filling it.");
  await insertText(client, f.tabId, text);
}

/** Looks for the form a few times: pages often draw the next step a moment later. */
async function findForm(client: BrowserClient, f: Form): Promise<Found> {
  const find = () => login<Found>(client, f.tabId, { op: "find", marker: f.marker });
  let found = await find();
  for (let i = 0; i < 4 && !found.pass && !found.code && !found.captcha; i++) {
    await sleep(Math.max(loadTiming.settleMs, loadTiming.pollMs));
    found = await find();
  }
  return found;
}

export const signInAction = defineAction({
  name: "browser.sign_in",
  description:
    "Sign in to the site open in a tab with the owner's saved login (see vault_logins), without seeing the password. Open the site's sign-in page first. Returns signed_in, needs_you (a code or a captcha: tell the owner) or failed.",
  input: z.object({
    tabId: z.number().int(),
    username: z
      .string()
      .max(300)
      .optional()
      .describe("Which saved login, when the site has more than one."),
  }),
  // D26: signing in sends nothing anywhere, so it doesn't ask; what comes after keeps its rules.
  risk: "internal",
  callers: CALLERS,
  // The address it ends on is the site's choice.
  external: true,
  async handler(i, ctx) {
    const client = browser(ctx);
    const vault = ctx.service<Vault>(VAULT_SERVICE);
    const first = await siteLogin(ctx, client, i.tabId, i.username);
    if (!first.row)
      throw new ActionError(
        "not_found",
        `There's no saved sign-in for ${first.host}${i.username ? ` as ${i.username}` : ""}. The owner can add one in Settings > Sign-ins.`,
      );
    const used = first.row;
    let passwordSent = false;
    let result: { status: "signed_in" | "needs_you" | "failed"; why?: string } | null = null;

    // A name, then a password, possibly on two pages.
    for (let step = 0; step < 3 && !passwordSent && !result; step++) {
      const { host, row } = await siteLogin(ctx, client, i.tabId, used.username);
      if (!row || row.id !== used.id) {
        result = {
          status: "needs_you",
          why: `The sign-in moved to ${host}, which isn't ${used.site}.`,
        };
        break;
      }
      await pace(ctx, `https://${host}/`);
      const form: Form = { tabId: i.tabId, marker: randomBytes(12).toString("hex"), host };
      const found = await findForm(client, form);
      if (found.code || found.captcha) {
        result = {
          status: "needs_you",
          why: found.code ? "It asks for a code." : "It shows a captcha.",
        };
        break;
      }
      if (!found.user && !found.pass) {
        if (step === 0)
          throw new ActionError(
            "not_found",
            "There's no sign-in form on this page. Open the site's sign-in page first.",
          );
        break;
      }
      const tab = await findTab(client, i.tabId);
      if (found.user) await fill(client, form, "user", used.username);
      if (found.pass) {
        // Checked again right before typing: the password goes to its own site only.
        const now = await siteLogin(ctx, client, i.tabId, used.username);
        if (now.row?.id !== used.id)
          throw new ActionError("failed", "The page moved while signing in.");
        await fill(client, form, "pass", vault.open(used.site, used.username, used.secret));
        passwordSent = true;
      }
      await pressKey(client, i.tabId, "Enter");
      await afterStep(ctx, client, tab);
    }

    if (!result) {
      await sleep(loadTiming.settleMs);
      const state = await login<Found>(client, i.tabId, { op: "state" });
      if (state.code || state.captcha)
        result = {
          status: "needs_you",
          why: state.code ? "It asks for a code." : "It shows a captcha.",
        };
      else if (!passwordSent)
        result = { status: "failed", why: "The site never asked for the password." };
      else if (state.pass)
        result = {
          status: "failed",
          why: "The site still asks for the password; the saved one may be out of date.",
        };
      else result = { status: "signed_in" };
    }
    await ctx.tx.update(vaultLogin).set({ lastUsedAt: ctx.now }).where(eq(vaultLogin.id, used.id));
    const tab = await findTab(client, i.tabId);
    ctx.emit({
      kind: "browser.signed_in",
      payload: { site: used.site, username: used.username, status: result.status },
    });
    return { tabId: i.tabId, site: used.site, username: used.username, url: tab.url, ...result };
  },
});
