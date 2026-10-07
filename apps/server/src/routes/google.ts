// Connecting a Google account. Settings asks /connect for Google's consent screen and goes there;
// Google sends you back to /callback on this PC (a loopback address, as Desktop-app clients
// require), which saves the account, pulls your calendars and returns you to Settings. /connect
// starts only on a POST, which only Hearth's own page can make (sameOriginWrites): a link to it,
// on any page or in a tab Jarvis was steered to open, starts nothing.
import { integrationCaller } from "@hearth/kernel";
import { GOOGLE_SERVICE, type GoogleClient, SCOPES } from "@hearth/modules";
import { Hono } from "hono";
import type { AppEnv } from "../env.ts";

const FEATURES: Record<string, readonly string[]> = {
  calendar: SCOPES.calendar,
  gmail: SCOPES.gmail,
};

export function googleRoutes() {
  const r = new Hono<AppEnv>();

  r.get("/connect", (c) => {
    c.header("Allow", "POST");
    return c.text("Connect Google from Hearth's Settings page.", 405);
  });

  /** Google's consent screen for what's asked `for` ("calendar", "calendar,gmail"), to go to. */
  r.post("/connect", async (c) => {
    const caller = c.get("caller");
    if (caller?.kind !== "owner") return c.json({ error: "Sign in to Hearth first." }, 401);
    const { kernel } = c.get("deps");
    const google = kernel.services[GOOGLE_SERVICE] as GoogleClient | undefined;
    if (!google?.configured)
      return c.json(
        {
          error:
            "Google isn't set up yet: add HEARTH_GOOGLE_CLIENT_ID and HEARTH_GOOGLE_CLIENT_SECRET to .env and restart Hearth.",
        },
        503,
      );
    const wanted = (c.req.query("for") ?? "calendar").split(",");
    const scopes = wanted.flatMap((w) => FEATURES[w] ?? []);
    if (scopes.length === 0) return c.json({ error: "Nothing to connect." }, 400);
    c.header("Cache-Control", "no-store");
    return c.json({ url: await google.startSignIn(kernel.db, scopes, kernel.clock.now()) });
  });

  r.get("/callback", async (c) => {
    const { kernel, config } = c.get("deps");
    const google = kernel.services[GOOGLE_SERVICE] as GoogleClient | undefined;
    const back = (msg: string) =>
      c.redirect(`${config.origin}/settings?google=${encodeURIComponent(msg)}`);
    if (!google?.configured) return c.text("Google isn't set up yet.", 503);
    const error = c.req.query("error");
    if (error)
      return back(error === "access_denied" ? "Cancelled." : "Google didn't connect. Try again.");
    const state = c.req.query("state");
    const code = c.req.query("code");
    if (!state || !code) return c.text("Missing sign-in details.", 400);
    let email: string;
    try {
      email = await google.finishSignIn(kernel.db, state, code, kernel.clock.now());
    } catch (err) {
      return back(err instanceof Error ? err.message : "That didn't work.");
    }
    // Pull calendars right away so they're there when you land back in Settings. Mail takes
    // longer, so its first batch starts in the background; the worker brings in the rest. Both
    // spend from the same paced Gmail budget as the worker, and a sync the worker already has
    // running for this account is skipped (D55).
    await kernel.execute("calendar.sync", {}, integrationCaller("google"));
    void kernel
      .execute("mail.sync", { account: email }, integrationCaller("google"))
      .catch(() => {});
    return back(`Connected ${email}.`);
  });

  return r;
}
