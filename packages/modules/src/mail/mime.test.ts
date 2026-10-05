import { describe, expect, it } from "vitest";
import {
  buildMessage,
  htmlToText,
  idList,
  isBulk,
  parseMail,
  rawHeaders,
  snippetOf,
} from "./mime.ts";

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

  it("tells mail sent to many at once or by a machine by its headers", async () => {
    const raw = (head: string) =>
      Buffer.from(`From: a@x.example\r\n${head}Subject: Hi\r\n\r\nList-Id: <in.the.body>\r\n`);
    // Folded over two lines, and only the headers count, not the text below them.
    expect(isBulk(rawHeaders(raw("List-Unsubscribe:\r\n <mailto:u@x.example>\r\n")))).toBe(true);
    expect(isBulk(rawHeaders(raw("")))).toBe(false);
    expect(isBulk(rawHeaders(raw("Precedence: Bulk\r\n")))).toBe(true);
    expect(isBulk(rawHeaders(raw("Precedence: first-class\r\n")))).toBe(false);
    expect(isBulk(rawHeaders(raw("Auto-Submitted: auto-generated\r\n")))).toBe(true);
    expect(isBulk(rawHeaders(raw("Auto-Submitted: no\r\n")))).toBe(false);
    expect(isBulk(rawHeaders(raw("List-Id: \r\n")))).toBe(false);
    // parseMail reads the same.
    expect((await parseMail(raw("List-Id: <club.x.example>\r\n"))).bulk).toBe(true);
    expect((await parseMail(raw(""))).bulk).toBe(false);
  });

  it("reads HTML-only mail as text, and quotes stay out of previews", () => {
    expect(
      htmlToText("<style>p{}</style><p>Hi&nbsp;there &amp; welcome</p><ul><li>One</li></ul>"),
    ).toBe("Hi there & welcome\n- One");
    expect(snippetOf("Sounds good.\n> On Friday you wrote:\n> lunch?")).toBe("Sounds good.");
    expect(idList("<a@x> <b@y>")).toEqual(["a@x", "b@y"]);
  });
});
