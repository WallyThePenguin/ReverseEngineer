import { describe, expect, it } from "vitest";
import { initials, TINTS, tintOf } from "./avatar.ts";

describe("initials", () => {
  it("are a first and a last name's letters", () => {
    expect(initials("Dana Ruiz")).toBe("DR");
    expect(initials("Dana Maria Ruiz")).toBe("DR");
    expect(initials("cher")).toBe("C");
    expect(initials("  Dana   Ruiz  ")).toBe("DR");
  });

  it("read a name written last name first", () => {
    expect(initials("Ruiz, Dana")).toBe("DR");
    expect(initials("Ruiz, Dana, MD")).toBe("DR");
  });

  it("leave out a title or a company after a whole name", () => {
    expect(initials("Dana Ruiz, MD")).toBe("DR");
    expect(initials("Dana Ruiz, Acme, Inc.")).toBe("DR");
  });

  it("skip quotes, brackets and an address written into the name", () => {
    expect(initials('"Dana Ruiz"')).toBe("DR");
    expect(initials("(Dana) Ruiz")).toBe("DR");
    expect(initials("Dana Ruiz <dana@example.com>")).toBe("DR");
    expect(initials("Dana - Ruiz")).toBe("DR");
  });

  it("come from the address when there's no name", () => {
    expect(initials(null, "dana.ruiz@example.com")).toBe("DR");
    expect(initials("", "dana@example.com")).toBe("D");
    expect(initials(undefined, "dana_ruiz+news@example.com")).toBe("DR");
    expect(initials("dana.ruiz@example.com")).toBe("DR");
  });

  it("keep letters outside English whole, and leave out what isn't a letter", () => {
    expect(initials("Élodie Ångström")).toBe("ÉÅ");
    expect(initials("渡辺 健")).toBe("渡健");
    expect(initials("🙂 Dana")).toBe("D");
  });

  it("are a question mark when there's nothing to go on", () => {
    expect(initials()).toBe("?");
    expect(initials("", "")).toBe("?");
    expect(initials("--", "@example.com")).toBe("?");
  });
});

describe("tintOf", () => {
  it("is the same for one address however it's written", () => {
    expect(tintOf("Dana@Example.com")).toBe(tintOf(" dana@example.com "));
  });

  it("is one of the tints, and people are spread across all of them", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const tint = tintOf(`person${i}@example.com`);
      expect(tint).toBeGreaterThanOrEqual(0);
      expect(tint).toBeLessThan(TINTS);
      seen.add(tint);
    }
    expect(seen.size).toBe(TINTS);
  });
});
