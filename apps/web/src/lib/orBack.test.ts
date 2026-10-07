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

  it("leaves a choice made since alone: its own save carries it", async () => {
    const choice = { value: "urgent" } as HTMLSelectElement;
    let refuse = (_: null) => {};
    const saving = new Promise<null>((r) => {
      refuse = r;
    });
    const first = orBack(choice, saving, () => "normal");
    choice.value = "low";
    refuse(null);
    await first;
    expect(choice.value).toBe("low");
  });

  it("leaves a field you're in until you leave it, and puts one you've left back", async () => {
    // A Due box after its date picker, or a field sent with Enter: the focus is still in it.
    const field = Object.assign(new EventTarget(), {
      tagName: "INPUT",
      type: "text",
      value: "Oct 9",
    });
    const doc = { activeElement: field as unknown as Element | null };
    Object.defineProperty(field, "ownerDocument", { value: doc });
    const el = field as unknown as HTMLInputElement;
    await orBack(el, Promise.resolve(null), () => "Oct 8");
    expect(field.value).toBe("Oct 9");
    doc.activeElement = null;
    field.dispatchEvent(new Event("blur"));
    expect(field.value).toBe("Oct 8");
    // Left already when the answer comes: back at once.
    field.value = "Oct 9";
    await orBack(el, Promise.resolve(null), () => "Oct 8");
    expect(field.value).toBe("Oct 8");
  });

  it("leaves a field changed before you leave it: its own save carries it", async () => {
    const field = Object.assign(new EventTarget(), {
      tagName: "INPUT",
      type: "text",
      value: "Oct 9",
    });
    Object.defineProperty(field, "ownerDocument", { value: { activeElement: field } });
    await orBack(field as unknown as HTMLInputElement, Promise.resolve(null), () => "Oct 8");
    field.value = "Oct 10";
    field.dispatchEvent(new Event("blur"));
    expect(field.value).toBe("Oct 10");
  });
});
