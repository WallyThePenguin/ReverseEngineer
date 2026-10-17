// What the app makes of Hearth's replies when something's wrong: a plain message to show, never
// a silent nothing or a proxy's error page.
import { afterEach, describe, expect, it, vi } from "vitest";
import { action, decideApproval, getMe } from "./api.ts";

const reply = (status: number, body: string, type = "application/json") =>
  vi.stubGlobal(
    "fetch",
    async () => new Response(body, { status, headers: { "content-type": type } }),
  );

afterEach(() => vi.unstubAllGlobals());

const DOWN = "Nook's database isn't reachable right now. Try again in a moment.";
const UNREACHABLE = "Can't reach Nook right now. Try again in a moment.";

describe("replies that aren't a result", () => {
  it("show Hearth's own reason, for an action or an approval", async () => {
    reply(503, JSON.stringify({ error: DOWN }));
    await expect(action("task.create", { title: "x" })).rejects.toMatchObject({ message: DOWN });
    await expect(decideApproval("a1", "approve")).rejects.toMatchObject({
      status: 503,
      message: DOWN,
    });
  });

  it("say Hearth can't be reached for a proxy's error page or no answer at all", async () => {
    reply(502, "<h1>502 Bad Gateway</h1>", "text/html");
    await expect(decideApproval("a1", "deny")).rejects.toMatchObject({ message: UNREACHABLE });
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(action("task.create", {})).rejects.toMatchObject({ code: "unreachable" });
  });

  it("pass a refusal or a failure through as the result it is", async () => {
    reply(500, JSON.stringify({ status: "error", code: "failed", message: "Couldn't save it." }));
    expect(await decideApproval("a1", "approve")).toEqual({
      status: "error",
      code: "failed",
      message: "Couldn't save it.",
    });
  });

  it("start-up waits for a real answer about who you are", async () => {
    reply(502, "<h1>502 Bad Gateway</h1>", "text/html");
    await expect(getMe()).rejects.toMatchObject({ code: "unreachable" });
    reply(200, "<html>the app</html>", "text/html");
    await expect(getMe()).rejects.toMatchObject({ code: "unreachable" });
    reply(200, JSON.stringify({ signedIn: false, principal: null, needsSetup: true }));
    expect(await getMe()).toMatchObject({ signedIn: false, needsSetup: true });
  });
});
