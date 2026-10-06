// A draft never opens with someone it goes to folded out of sight.
import { describe, expect, it } from "vitest";
import { foldsExtras, showsCc } from "./compose.ts";

const ana = { address: "ana@example.com", name: "Ana" };
const stranger = { address: "records@evil.example" };

describe("what a draft shows when it opens", () => {
  it("folds Bcc and Subject on a plain reply", () => {
    const reply = { threadId: "t1", cc: [], bcc: [] };
    expect(foldsExtras(reply)).toBe(true);
    expect(showsCc(reply)).toBe(false);
  });

  it("shows a reply's Bcc when anyone is on it, as Jarvis's drafts can have", () => {
    const reply = { threadId: "t1", cc: [], bcc: [stranger] };
    expect(foldsExtras(reply)).toBe(false);
    expect(showsCc(reply)).toBe(true);
  });

  it("keeps a reply's Cc showing when it starts with someone on it", () => {
    const replyAll = { threadId: "t1", cc: [ana], bcc: [] };
    expect(foldsExtras(replyAll)).toBe(true);
    expect(showsCc(replyAll)).toBe(true);
  });

  it("shows everything on a new email", () => {
    const fresh = { threadId: null, cc: [], bcc: [] };
    expect(foldsExtras(fresh)).toBe(false);
    expect(showsCc(fresh)).toBe(true);
  });
});
