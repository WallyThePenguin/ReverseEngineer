import { describe, expect, it } from "vitest";
import { speakable } from "./speech.ts";

describe("speakable", () => {
  it("reads words, not markdown", () => {
    expect(
      speakable("## Today\n- **Dentist** at 3, see [the invite](https://x.y/z)\n- https://a.b"),
    ).toBe("Today Dentist at 3, see the invite a link");
  });
});
