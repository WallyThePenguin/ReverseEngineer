import { describe, expect, it } from "vitest";
import { quickAdd } from "./quickadd.ts";

function box(initial: string) {
  let value = initial;
  return {
    get: () => value,
    set: (v: string) => {
      value = v;
    },
  };
}

describe("quick add", () => {
  it("clears the box before the answer, so the next entry starts fresh", async () => {
    const b = box("Renew passport");
    const sent: string[] = [];
    let answer!: (v: { id: string }) => void;
    const done = quickAdd(b, (text) => {
      sent.push(text);
      return new Promise<{ id: string } | null>((r) => {
        answer = r;
      });
    });
    expect(b.get()).toBe("");
    b.set("Plan the kitchen");
    answer({ id: "1" });
    expect(await done).toEqual({ id: "1" });
    expect(sent).toEqual(["Renew passport"]);
    expect(b.get()).toBe("Plan the kitchen");
  });

  it("puts the text back when it fails, unless you've typed something else", async () => {
    const b = box("  Call the dentist ");
    expect(await quickAdd(b, async () => null)).toBeNull();
    expect(b.get()).toBe("Call the dentist");

    const c = box("First");
    await quickAdd(c, async () => {
      c.set("Second");
      return null;
    });
    expect(c.get()).toBe("Second");
  });

  it("sends nothing for an empty box", async () => {
    let called = false;
    expect(await quickAdd(box("   "), async () => (called = true))).toBeNull();
    expect(called).toBe(false);
  });
});
