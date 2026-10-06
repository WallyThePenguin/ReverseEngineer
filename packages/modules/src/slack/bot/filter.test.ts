// The one filter every post of Jarvis's goes through (D62): whatever the text says, it can't ping
// a channel, @name someone, hide where a link goes or unfurl a page, and a member's answer carries
// only the links you wrote in a shared answer.
import { afterEach, describe, expect, it, vi } from "vitest";
import { OUTBOX_EVENT } from "../api.ts";
import { httpSlackBot } from "./api.ts";
import { POST_FLAGS, POST_MAX, slackText } from "./filter.ts";

describe("what Jarvis posts in Slack", () => {
  it("can't make a mention, a channel ping or a link that says one thing and goes to another", () => {
    const text =
      "Hey <!channel> and <!here>, ask <@U0BOSS> or <#C0SECRET>: <https://evil.example|bank.com>";
    expect(slackText(text)).toBe(
      "Hey &lt;!channel&gt; and &lt;!here&gt;, ask &lt;@U0BOSS&gt; or &lt;#C0SECRET&gt;: &lt;https://evil.example|bank.com&gt;",
    );
    // An & of the text's own can't finish an entity Slack would read either.
    expect(slackText("a &lt;!channel&gt; b")).toBe("a &amp;lt;!channel&amp;gt; b");
  });

  it("shows Hearth's link tags as their labels, and drops a stray piece of one", () => {
    const ref = '<m-ref type="task" id="7c1f">Fix &amp; ship &lt;!channel&gt;</m-ref>';
    expect(slackText(`Done: ${ref}.`)).toBe("Done: Fix &amp; ship &lt;!channel&gt;.");
    expect(slackText('half <m-ref type="task" id="1"> open')).toBe("half  open");
  });

  it("turns markdown into Slack's mrkdwn without making a link", () => {
    const md = [
      "## Today",
      "- **Ship** the *fix*",
      "* ~~old~~ new, see [the plan](https://acme.example/plan)",
      "Keep `**this**` as it is",
      "```",
      "# not a heading **nor bold**",
      "```",
    ].join("\n");
    expect(slackText(md)).toBe(
      [
        "*Today*",
        "• *Ship* the _fix_",
        "• ~old~ new, see the plan (https://acme.example/plan)",
        "Keep `**this**` as it is",
        "```",
        "# not a heading **nor bold**",
        "```",
      ].join("\n"),
    );
  });

  it("is cut at 3,000 characters, never through one", () => {
    const long = "🙂".repeat(POST_MAX + 10);
    const out = slackText(long);
    expect([...out]).toHaveLength(POST_MAX);
    expect(out.endsWith("🙂…")).toBe(true);
    expect(slackText("x".repeat(POST_MAX))).toBe("x".repeat(POST_MAX));
  });

  it("keeps in a member's answer only the links written in a shared answer", () => {
    const shared = new Set(["https://acme.example/handbook", "help@acme.example"]);
    const text = [
      "The handbook: https://acme.example/handbook.",
      "Or log in at https://evil.example/login, evil.example.com/reset or www.evil.example.",
      "Write to help@acme.example, not boss@evil.example.",
      "[Your payslip](https://evil.example/pay) and [handbook](https://acme.example/handbook)",
    ].join("\n");
    expect(slackText(text, { sharedLinks: shared })).toBe(
      [
        "The handbook: https://acme.example/handbook.",
        "Or log in at , or .",
        "Write to help@acme.example, not .",
        "Your payslip and handbook (https://acme.example/handbook)",
      ].join("\n"),
    );
    // Your own words keep their links.
    expect(slackText("See https://evil.example/login")).toBe("See https://evil.example/login");
  });
});

describe("how a post is sent", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("with no parsing, no @names, no previews, and the outbox row's id in its metadata", async () => {
    const sent: { method: string; form: URLSearchParams }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({
        method: new URL(String(url)).pathname.split("/").pop()!,
        form: new URLSearchParams(String(init?.body ?? "")),
      });
      return new Response(JSON.stringify({ ok: true, channel: "D1", ts: "1700000000.000100" }));
    });
    const bot = httpSlackBot("https://slack.test/api");
    const token = "xoxb-1111-2222-bottest";
    expect(
      await bot.post(token, { channel: "U1", text: "hi", threadTs: "1.000100", outboxId: "o1" }),
    ).toEqual({ channel: "D1", ts: "1700000000.000100" });
    await bot.postEphemeral(token, { channel: "C1", user: "U1", text: "only you" });
    expect(sent.map((s) => s.method)).toEqual(["chat.postMessage", "chat.postEphemeral"]);
    for (const { form } of sent)
      for (const [flag, value] of Object.entries(POST_FLAGS)) expect(form.get(flag)).toBe(value);
    expect(POST_FLAGS).toEqual({
      parse: "none",
      link_names: "false",
      unfurl_links: "false",
      unfurl_media: "false",
    });
    expect(sent[0]!.form.get("thread_ts")).toBe("1.000100");
    expect(JSON.parse(sent[0]!.form.get("metadata")!)).toEqual({
      event_type: OUTBOX_EVENT,
      event_payload: { id: "o1" },
    });
  });
});
