import { describe, expect, it } from "vitest";
import { buildMessage, htmlToText, idList, parseMail, snippetOf } from "./mime.ts";

describe("raw email", () => {
  it("writes what it reads: names, accents, threading headers, HTML and attachments", async () => {
    const raw = buildMessage({
      from: { address: "me@example.com", name: "Waleed" },
      to: [{ address: "ana@example.com", name: "Ana Müller" }],
      cc: [{ address: "bo@example.com" }],
      subject: "Café on Friday? ☕",
      text: "See you there.",
      html: "<p>See you <b>there</b>.</p>",
      messageId: "abc@example.com",
      inReplyTo: "root@example.com",
      references: ["root@example.com"],
      attachments: [
        { filename: "menu.pdf", mimeType: "application/pdf", content: Buffer.from("%PDF") },
      ],
    });
    const m = await parseMail(raw);
    expect(m).toMatchObject({
      messageId: "abc@example.com",
      inReplyTo: "root@example.com",
      references: ["root@example.com"],
      subject: "Café on Friday? ☕",
      from: { address: "me@example.com", name: "Waleed" },
      to: [{ address: "ana@example.com", name: "Ana Müller" }],
      cc: [{ address: "bo@example.com" }],
      text: "See you there.",
      html: "<p>See you <b>there</b>.</p>",
    });
    expect(m.attachments.map((a) => [a.filename, a.mimeType, a.content.toString()])).toEqual([
      ["menu.pdf", "application/pdf", "%PDF"],
    ]);
  });

  it("reads HTML-only mail as text, and quotes stay out of previews", () => {
    expect(
      htmlToText("<style>p{}</style><p>Hi&nbsp;there &amp; welcome</p><ul><li>One</li></ul>"),
    ).toBe("Hi there & welcome\n- One");
    expect(snippetOf("Sounds good.\n> On Friday you wrote:\n> lunch?")).toBe("Sounds good.");
    expect(idList("<a@x> <b@y>")).toEqual(["a@x", "b@y"]);
  });
});
