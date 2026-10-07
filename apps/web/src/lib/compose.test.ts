// A draft never opens with someone it goes to, or a subject nobody chose here, folded out of sight,
// and a change saved elsewhere while you type is merged with yours, not written over it.
import { describe, expect, it } from "vitest";
import {
  type DraftFields,
  draftInput,
  fieldsFold,
  fieldsOf,
  foldsExtras,
  mergeDraft,
  replySubject,
  showAddresses,
  showsCc,
  splitAddresses,
} from "./compose.ts";

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

  it("unfolds Bcc and Subject once a change from elsewhere fills Bcc or changes the Subject", () => {
    const shown = { bcc: "", subject: "Re: Lunch" };
    expect(fieldsFold(shown, "Lunch")).toBe(true);
    expect(fieldsFold({ ...shown, bcc: "sam@x.example" }, "Lunch")).toBe(false);
    expect(fieldsFold({ ...shown, subject: "Re: Lunch (and the bank details)" }, "Lunch")).toBe(
      false,
    );
    expect(fieldsFold(shown)).toBe(false);
  });

  it("makes the reply subject the way mail.draft does", () => {
    expect(replySubject("Lunch")).toBe("Re: Lunch");
    expect(replySubject("re: Lunch")).toBe("re: Lunch");
  });
});

describe("a draft changed elsewhere while you type", () => {
  const base: DraftFields = {
    from: "me@example.com",
    to: "Ana <ana@example.com>",
    cc: "",
    bcc: "",
    subject: "Lunch",
    text: "Friday?",
  };

  it("keeps the fields you changed and takes the rest from theirs", () => {
    const mine = { ...base, to: "Ana <ana@example.com>, bo@exa", subject: "Lunch on Friday" };
    const theirs = { ...base, cc: "sam@example.com", subject: "Lunch (Jarvis)" };
    expect(mergeDraft(base, mine, theirs)).toEqual({
      ...base,
      to: "Ana <ana@example.com>, bo@exa",
      cc: "sam@example.com",
      subject: "Lunch on Friday",
    });
  });

  it("keeps the message lines both sides wrote", () => {
    const mine = { ...base, text: "Friday?\nI can do noon." };
    const theirs = { ...base, text: "Friday?\nOr Saturday." };
    expect(mergeDraft(base, mine, theirs).text).toBe("Friday?\nI can do noon.\nOr Saturday.");
    // Nothing changed here: theirs, as it is.
    expect(mergeDraft(base, base, theirs)).toEqual(theirs);
  });

  it("shows a draft's addresses the way it splits them again", () => {
    const d = fieldsOf({
      id: "d1",
      account: null,
      threadId: null,
      to: [{ address: "ana@example.com", name: "Ana" }, { address: "bo@exa" }],
      cc: [],
      bcc: [],
      subject: "",
      text: "",
      updatedAt: "",
      version: 3,
      by: "owner",
    });
    expect(d.to).toBe("Ana <ana@example.com>, bo@exa");
    expect(splitAddresses(`${d.to};\n sam@example.com, `)).toEqual([
      "Ana <ana@example.com>",
      "bo@exa",
      "sam@example.com",
    ]);
  });
});

describe("recipients as a field shows and saves them", () => {
  it("splits a name with a comma or semicolon back into one recipient, as it showed it", () => {
    const xs = [
      { address: "ana@x.example", name: "Silva, Ana" },
      { address: "boss@x.example", name: "x@evil.example, Boss" },
      { address: "ab@x.example", name: "A; B" },
      { address: "bo@x.example", name: "Bo Li" },
    ];
    expect(showAddresses(xs)).toBe(
      '"Silva, Ana" <ana@x.example>, "x@evil.example, Boss" <boss@x.example>, "A; B" <ab@x.example>, Bo Li <bo@x.example>',
    );
    expect(splitAddresses(showAddresses(xs))).toEqual([
      '"Silva, Ana" <ana@x.example>',
      '"x@evil.example, Boss" <boss@x.example>',
      '"A; B" <ab@x.example>',
      "Bo Li <bo@x.example>",
    ]);
  });

  it("splits a pasted column of addresses, and keeps a quote left open as typed", () => {
    expect(splitAddresses("ana@x.example bo@x.example\tsam@x.example")).toEqual([
      "ana@x.example",
      "bo@x.example",
      "sam@x.example",
    ]);
    expect(splitAddresses("Ana Silva <ana@x.example>")).toEqual(["Ana Silva <ana@x.example>"]);
    expect(splitAddresses('"Silva, Ana <ana@x.example>, bo@x.example\nsam@x.example')).toEqual([
      '"Silva, Ana <ana@x.example>, bo@x.example',
      "sam@x.example",
    ]);
  });

  it("saves a draft on its version, naming From only when another was picked", () => {
    const d: DraftFields = {
      from: "me@x.example",
      to: '"Silva, Ana" <ana@x.example>',
      cc: "",
      bcc: "sam@x.example",
      subject: "Re: Lunch",
      text: "Friday?",
    };
    expect(draftInput("d1", d, 4)).toEqual({
      id: "d1",
      baseVersion: 4,
      to: ['"Silva, Ana" <ana@x.example>'],
      cc: [],
      bcc: ["sam@x.example"],
      subject: "Re: Lunch",
      text: "Friday?",
    });
    expect(draftInput("d1", d, 4, "work@x.example")).toMatchObject({ account: "work@x.example" });
  });
});
