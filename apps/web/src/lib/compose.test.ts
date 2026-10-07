// A draft never opens with someone it goes to, or a subject nobody chose here, folded out of sight.
import { describe, expect, it } from "vitest";
import { foldsExtras, replySubject, showsCc } from "./compose.ts";

const ana = { address: "ana@example.com", name: "Ana" };
const stranger = { address: "records@evil.example" };
const reply = (more: Partial<Parameters<typeof foldsExtras>[0]> = {}) => ({
  threadId: "t1",
  cc: [],
  bcc: [],
  subject: "Re: Lunch",
  ...more,
});

describe("what a draft shows when it opens", () => {
  it("folds Bcc and Subject on a plain reply", () => {
    expect(foldsExtras(reply(), "Lunch")).toBe(true);
    expect(showsCc(reply(), "Lunch")).toBe(false);
    // A conversation already called "Re: …" isn't given a second one.
    expect(foldsExtras(reply({ subject: "RE: Lunch" }), "RE: Lunch")).toBe(true);
  });

  it("shows a reply's Bcc when anyone is on it, as Jarvis's drafts can have", () => {
    const hidden = reply({ bcc: [stranger] });
    expect(foldsExtras(hidden, "Lunch")).toBe(false);
    expect(showsCc(hidden, "Lunch")).toBe(true);
  });

  it("shows a reply's Subject when it isn't the conversation's, as Jarvis can write one", () => {
    const changed = reply({ subject: "Re: Lunch (and the bank details from Sam)" });
    expect(foldsExtras(changed, "Lunch")).toBe(false);
    expect(showsCc(changed, "Lunch")).toBe(true);
  });

  it("shows everything when the conversation isn't at hand to compare with", () => {
    expect(foldsExtras(reply())).toBe(false);
  });

  it("keeps a reply's Cc showing when it starts with someone on it", () => {
    const replyAll = reply({ cc: [ana] });
    expect(foldsExtras(replyAll, "Lunch")).toBe(true);
    expect(showsCc(replyAll, "Lunch")).toBe(true);
  });

  it("shows everything on a new email", () => {
    const fresh = { threadId: null, cc: [], bcc: [], subject: "Hello" };
    expect(foldsExtras(fresh, "Hello")).toBe(false);
    expect(showsCc(fresh)).toBe(true);
  });

  it("makes the reply subject the way mail.draft does", () => {
    expect(replySubject("Lunch")).toBe("Re: Lunch");
    expect(replySubject("re: Lunch")).toBe("re: Lunch");
  });
});
