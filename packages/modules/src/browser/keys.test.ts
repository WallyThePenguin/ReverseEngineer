import { describe, expect, it } from "vitest";
import { FREE } from "./classify.ts";
import { isPaste, keyEvents, parseCombo, parseKeys, types } from "./keys.ts";
import { keyRefusal } from "./steps.ts";

describe("keys as a person presses them", () => {
  it("reads presses and combinations", () => {
    expect(parseKeys("ctrl+a Backspace").map((c) => c.name)).toEqual(["ctrl+a", "Backspace"]);
    expect(parseCombo("shift+Tab")).toMatchObject({ shift: true, key: { key: "Tab", keyCode: 9 } });
    expect(parseCombo("cmd+shift+z")).toMatchObject({ meta: true, shift: true, key: { key: "Z" } });
    expect(parseCombo("A")).toMatchObject({ shift: true, key: { key: "A", code: "KeyA" } });
    expect(parseCombo("?")).toMatchObject({ shift: true, key: { code: "Slash" } });
    expect(parseCombo("ctrl++")).toMatchObject({ ctrl: true, key: { key: "+" } });
    expect(parseCombo("esc").key.key).toBe("Escape");
    expect(parseCombo("F5").key).toEqual({ key: "F5", code: "F5", keyCode: 116 });
    expect(() => parseCombo("hyper+a")).toThrow(/modifier/);
    expect(() => parseCombo("ctrl+Banana")).toThrow(/isn't a key/);
  });

  it("holds modifiers down around the key, with the protocol's bits", () => {
    const events = keyEvents(parseCombo("ctrl+a"));
    expect(events.map((e) => [e.type, e.key, e.modifiers])).toEqual([
      ["rawKeyDown", "Control", 2],
      ["rawKeyDown", "a", 2],
      ["keyUp", "a", 2],
      ["keyUp", "Control", 0],
    ]);
    expect(events[1]).toMatchObject({ commands: ["selectAll"] });
    expect(keyEvents(parseCombo("Enter"))[0]).toMatchObject({ type: "keyDown", text: "\r" });
    expect(keyEvents(parseCombo("x"))[0]).toMatchObject({ type: "keyDown", text: "x" });
  });

  it("knows what types and what pastes", () => {
    expect(types(parseCombo("x"))).toBe(true);
    expect(types(parseCombo("ctrl+x"))).toBe(false);
    expect(types(parseCombo("Tab"))).toBe(false);
    expect(isPaste(parseCombo("ctrl+v"))).toBe(true);
    expect(isPaste(parseCombo("meta+V"))).toBe(true);
    expect(isPaste(parseCombo("shift+Insert"))).toBe(true);
    expect(isPaste(parseCombo("v"))).toBe(false);
  });
});

describe("which keys need the owner", () => {
  const sends = { sends: true, floor: null, why: "send it" };
  const field = { kind: "field", label: "Note", editable: true, enter: sends, click: FREE };
  const textArea = { ...field, kind: "text area" };
  const button = { kind: "button", label: "Send", editable: false, enter: sends, click: sends };
  const body = { kind: null, editable: false };
  const refused = (keys: string, active: object, trusted = false) =>
    keyRefusal(parseCombo(keys), active as never, trusted);

  it.each([
    ["Enter in a field that sends", "Enter", field, false, true],
    ["the same on a trusted site", "Enter", field, true, false],
    ["shift+Enter in a text box", "shift+Enter", textArea, false, false],
    ["ctrl+Enter in a text box", "ctrl+Enter", textArea, false, true],
    ["Space on a button that sends", "Space", button, false, true],
    ["Space in a field", "Space", field, false, false],
    ["a letter outside any field", "e", body, false, true],
    ["a letter outside any field, trusted", "e", body, true, false],
    ["Escape anywhere", "Escape", body, false, false],
    ["Tab anywhere", "Tab", button, false, false],
    ["an arrow on a list", "ArrowDown", { kind: "select", editable: false }, true, true],
    ["typing into a password field", "a", { ...field, password: true }, true, true],
    ["typing into a card field", "4", { ...field, card: true }, true, true],
    [
      "Enter on a payment button, trusted",
      "Enter",
      { ...button, click: { ...sends, floor: "payment" } },
      true,
      true,
    ],
  ])("%s", (_name, keys, active, trusted, isRefused) => {
    expect(refused(keys, active, trusted) !== null).toBe(isRefused);
  });
});
