// A box or a choice whose save didn't go through shows what's saved again, so the next tick asks
// for what it shows. (A checklist box in a task, with its save failing in a browser, is in
// e2e:daily.)
import { describe, expect, it } from "vitest";
import { orBack } from "./orBack.ts";

const box = (checked: boolean) => ({ type: "checkbox", checked }) as HTMLInputElement;

describe("orBack", () => {
  it("puts a ticked box back when its save didn't go through", async () => {
    // A checklist line, unticked in what's saved: ticked, and Hearth didn't take it.
    const b = box(true);
    expect(await orBack(b, Promise.resolve(false), () => false)).toBe(false);
    expect(b.checked).toBe(false);
    const c = box(false);
    await orBack(c, Promise.resolve(null), () => true);
    expect(c.checked).toBe(true);
  });

  it("leaves it as it is when the save went through", async () => {
    const b = box(true);
    await orBack(b, Promise.resolve(true), () => false);
    expect(b.checked).toBe(true);
    await orBack(b, Promise.resolve({ id: "t1" }), () => false);
    expect(b.checked).toBe(true);
  });

  it("puts a choice back to what's saved", async () => {
    const choice = { value: "urgent" } as HTMLSelectElement;
    await orBack(choice, Promise.resolve(null), () => "normal");
    expect(choice.value).toBe("normal");
  });
});
