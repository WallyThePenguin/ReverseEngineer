import { describe, expect, it } from "vitest";
import { encodeWav } from "./wav.ts";

describe("encodeWav", () => {
  it("writes a 16-bit mono PCM WAV", () => {
    const buf = encodeWav(new Float32Array([0, 1, -1, 2]), 16_000);
    const v = new DataView(buf);
    const text = (at: number) => String.fromCharCode(...new Uint8Array(buf, at, 4));
    expect([text(0), text(8), text(12), text(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    expect(v.getUint32(24, true)).toBe(16_000);
    expect(v.getUint32(40, true)).toBe(8);
    expect([1, 2, 3].map((i) => v.getInt16(44 + i * 2, true))).toEqual([32767, -32767, 32767]);
  });
});
