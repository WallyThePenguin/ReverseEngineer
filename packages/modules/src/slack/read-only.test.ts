// Your own Slack token only ever reads (D62). The app keeps its user write scopes for something
// else of yours, so Slack would take a post made with that token: Hearth's own code is what
// refuses to make one.
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertUserRead, httpSlack, USER_TOKEN_METHODS } from "./api.ts";
import { httpSlackBot } from "./bot/api.ts";

const XOXP = "xoxp-1111-2222-test";
const XOXB = "xoxb-1111-2222-bottest";
const BASE = "https://slack.test/api";

/** Answers every call ok, noting each method called and the token it came with. */
function stubSlack() {
  const seen: { method: string; token: string }[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({
      method: new URL(String(url)).pathname.split("/").pop()!,
      token: headers.authorization!,
    });
    const body = { ok: true, user: { id: "U1", profile: {} }, channel: { id: "D1" } };
    return new Response(JSON.stringify(body), {
      headers: { "x-oauth-scopes": "channels:history, search:read,chat:write" },
    });
  });
  return seen;
}
afterEach(() => vi.unstubAllGlobals());

describe("your own Slack token", () => {
  it("is used only for the reads on its list, and says what scopes it has", async () => {
    const seen = stubSlack();
    const api = httpSlack(BASE);
    expect((await api.whoami(XOXP)).scopes).toEqual([
      "channels:history",
      "search:read",
      "chat:write",
    ]);
    await api.conversations(XOXP);
    await api.history(XOXP, "C1", { oldest: "0", limit: 10 });
    await api.replies(XOXP, "C1", "1.0", { oldest: "0", limit: 10 });
    await api.user(XOXP, "U1");
    await api.mentions(XOXP, "U1");
    expect([...new Set(seen.map((s) => s.method))].sort()).toEqual([...USER_TOKEN_METHODS].sort());
    expect(seen.every((s) => s.token === `Bearer ${XOXP}`)).toBe(true);
  });

  it("lists no method that writes, and refuses one before anything is sent", () => {
    for (const m of USER_TOKEN_METHODS)
      expect(m).toMatch(
        /^(auth\.test|users\.(conversations|info)|conversations\.(history|replies)|search\.messages)$/,
      );
    const seen = stubSlack();
    for (const write of [
      "chat.postMessage",
      "chat.postEphemeral",
      "chat.update",
      "chat.delete",
      "chat.meMessage",
      "reactions.add",
      "conversations.open",
      "conversations.join",
      "im.open",
      "files.upload",
    ])
      expect(() => assertUserRead(write)).toThrow(/only reads/);
    expect(seen).toEqual([]);
  });

  it("is refused by the bot's client, which takes only the bot's token and the app's", async () => {
    const seen = stubSlack();
    const bot = httpSlackBot(BASE);
    await expect(bot.whoami(XOXP)).rejects.toThrow(/Only a xoxb- token/);
    await expect(bot.openDm(XOXP, "U1")).rejects.toThrow(/Only a xoxb- token/);
    await expect(bot.openSocket(XOXP)).rejects.toThrow(/Only a xapp- token/);
    await expect(bot.openSocket(XOXB)).rejects.toThrow(/Only a xapp- token/);
    expect(seen).toEqual([]);
    // The bot's own token goes through.
    expect(await bot.openDm(XOXB, "UME")).toBe("D1");
    expect(seen).toEqual([{ method: "conversations.open", token: `Bearer ${XOXB}` }]);
  });
});
