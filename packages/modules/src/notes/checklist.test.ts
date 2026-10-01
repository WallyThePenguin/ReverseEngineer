import { describe, expect, it } from "vitest";
import { linkItemToTask, openUnlinkedItems, parseChecklist } from "./checklist.ts";

const TASK = "018f3a2b-0000-7000-8000-000000000abc";

describe("checklists", () => {
  const body =
    "Errands\n- [ ] call the plumber\n- [x] buy milk\n* [ ]   \n  - [ ] renew passport\nnot an item";
  it("finds items and which are open", () => {
    expect(parseChecklist(body).map((i) => [i.line, i.checked])).toEqual([
      [1, false],
      [2, true],
      [3, false],
      [4, false],
    ]);
    expect(openUnlinkedItems(body).map((i) => i.text)).toEqual([
      "call the plumber",
      "renew passport",
    ]);
  });
  it("links an item to its task, after which it no longer counts as open", () => {
    const linked = linkItemToTask(body, 1, { id: TASK, label: "call the plumber" });
    expect(linked.split("\n")[1]).toBe(
      `- [ ] <m-ref type="task" id="${TASK}">call the plumber</m-ref>`,
    );
    expect(openUnlinkedItems(linked).map((i) => i.text)).toEqual(["renew passport"]);
    expect(linkItemToTask(body, 0, { id: TASK, label: "x" })).toBe(body);
  });
});
