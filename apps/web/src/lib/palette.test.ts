import { describe, expect, it } from "vitest";
import { arrange, type PaletteItem } from "./palette.ts";

const item = (id: string, label: string): PaletteItem => ({ id, label, hint: "", run: () => {} });
const COMMANDS = [
  item("go:inbox", "Go to Inbox"),
  item("go:settings", "Go to Settings"),
  item("go:trash", "Go to the trash (restore what you deleted)"),
  item("new:note", "New note"),
];
const ASK = [item("ask", "Ask Jarvis")];
const ids = (list: PaletteItem[]) => list.map((i) => i.id);

describe("Cmd+K", () => {
  it("puts the command you named above records that merely match", () => {
    const records = { query: "settings", list: [item("r1", "Settings ideas")] };
    expect(ids(arrange({ query: "settings", commands: COMMANDS, records, extra: ASK }))).toEqual([
      "go:settings",
      "r1",
      "ask",
    ]);
    expect(ids(arrange({ query: "tra", commands: COMMANDS, records, extra: [] }))[0]).toBe(
      "go:trash",
    );
  });

  it("never lists records found for something typed earlier", () => {
    const records = { query: "set", list: [item("old", "Set up the printer")] };
    expect(ids(arrange({ query: "settings", commands: COMMANDS, records, extra: ASK }))).toEqual([
      "go:settings",
      "ask",
    ]);
  });

  it("with nothing typed, shows recent records and the commands", () => {
    const records = { query: "", list: [item("r1", "Recent")] };
    expect(ids(arrange({ query: "", commands: COMMANDS, records, extra: ASK }))).toEqual([
      "r1",
      ...ids(COMMANDS),
    ]);
  });
});
