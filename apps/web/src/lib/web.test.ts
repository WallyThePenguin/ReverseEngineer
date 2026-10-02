import { renderMention } from "@hearth/core";
import { describe, expect, it } from "vitest";
import { type BrowserTab, defaultTab, modifiers, toPage } from "./browser.ts";
import { decodePath, encodePath, routeFor } from "./routes.ts";
import { lineDiff, mentionQuery, splitInline, toggleLine } from "./text.ts";

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

describe("the live browser view", () => {
  it("scales a click on the picture to the page's own pixels", () => {
    const shown = { left: 100, top: 50, width: 640, height: 450 };
    const page = { width: 1280, height: 900 };
    expect(toPage({ x: 420, y: 275 }, shown, page)).toEqual({ x: 640, y: 450 });
    expect(toPage({ x: 100, y: 50 }, shown, page)).toEqual({ x: 0, y: 0 });
  });

  it("sends Chrome's modifier bits", () => {
    const keys = { altKey: false, ctrlKey: true, metaKey: false, shiftKey: true };
    expect(modifiers(keys)).toBe(2 | 8);
  });

  it("shows Jarvis's tab in front first, then any of its tabs, then yours", () => {
    const tab = (tabId: number, handed: boolean, active: boolean): BrowserTab => ({
      tabId,
      windowId: 1,
      url: "",
      title: "",
      active,
      handed,
      loading: false,
    });
    expect(defaultTab([tab(1, true, true), tab(2, false, false), tab(3, false, true)])).toBe(3);
    expect(defaultTab([tab(1, true, true), tab(2, false, false)])).toBe(2);
    expect(defaultTab([tab(1, true, true)])).toBe(1);
    expect(defaultTab([])).toBeNull();
  });

  it("opens the browser pane from the URL", () => {
    expect(decodePath("/browser+inbox")).toEqual([{ view: "browser" }, { view: "inbox" }]);
  });
});

describe("page watch changes", () => {
  it("shows which lines were added and removed", () => {
    expect(lineDiff("Kettle\n$40\nIn stock", "Kettle\n$35\nIn stock")).toEqual([
      { kind: "same", text: "Kettle" },
      { kind: "removed", text: "$40" },
      { kind: "added", text: "$35" },
      { kind: "same", text: "In stock" },
    ]);
    expect(lineDiff("", "New")).toEqual([
      { kind: "removed", text: "" },
      { kind: "added", text: "New" },
    ]);
  });
});
