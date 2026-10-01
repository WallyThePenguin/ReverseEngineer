import { renderMention } from "@hearth/core";
import { describe, expect, it } from "vitest";
import { decodePath, encodePath, routeFor } from "./routes.ts";
import { mentionQuery, splitInline, toggleLine } from "./text.ts";

const ID = "01a0f976-b334-7462-a9ca-bd9b458c8a2c";

describe("pane routes", () => {
  it("round-trips a layout through the URL", () => {
    const panes = [{ view: "inbox" as const }, { view: "task" as const, id: ID }];
    expect(encodePath(panes)).toBe(`/inbox+task/${ID}`);
    expect(decodePath(encodePath(panes))).toEqual(panes);
  });

  it("falls back to the inbox and drops anything it doesn't recognise", () => {
    expect(decodePath("/")).toEqual([{ view: "inbox" }]);
    expect(decodePath("/nope+task/not-an-id+notes")).toEqual([{ view: "notes" }]);
    expect(decodePath(`/inbox+tasks+notes+note/${ID}`)).toHaveLength(3);
  });

  it("opens each record type in its own view", () => {
    expect(routeFor("note", ID)).toEqual({ view: "note", id: ID });
    expect(routeFor("conversation", ID)).toEqual({ view: "chat", id: ID });
    expect(routeFor("person", ID)).toEqual({ view: "record", id: ID });
  });
});

describe("mention typing", () => {
  it("finds the @query before the caret, up to four words", () => {
    expect(mentionQuery("Ask @Jar", 8)).toEqual({ start: 4, query: "Jar" });
    expect(mentionQuery("@Pay rent in May", 16)).toEqual({ start: 0, query: "Pay rent in May" });
    expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
  });

  it("ignores email addresses and finished mentions", () => {
    expect(mentionQuery("me@example.com", 14)).toBeNull();
    expect(mentionQuery(`@[Pay rent](task:${ID}) `, 50)).toBeNull();
  });
});

describe("rendering helpers", () => {
  it("splits a line into text and mentions", () => {
    const line = `See ${renderMention({ type: "task", id: ID, label: "Pay <rent>" })} &amp; more`;
    expect(splitInline(line)).toEqual([
      { kind: "text", text: "See " },
      { kind: "mention", type: "task", id: ID, label: "Pay <rent>" },
      { kind: "text", text: " & more" },
    ]);
  });

  it("ticks and unticks checklist lines", () => {
    const body = "# List\n- [ ] milk\n- [x] eggs";
    expect(toggleLine(body, 1)).toBe("# List\n- [x] milk\n- [x] eggs");
    expect(toggleLine(body, 2)).toBe("# List\n- [ ] milk\n- [ ] eggs");
    expect(toggleLine(body, 9)).toBe(body);
  });
});
