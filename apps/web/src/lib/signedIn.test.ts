// A device signed in last time draws Hearth at once; the server's answer always wins.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberSignedIn, showHearth, wasSignedIn } from "./signedIn.ts";

const store = new Map<string, string>();
beforeEach(() => {
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});
afterEach(() => {
  store.clear();
  vi.unstubAllGlobals();
});

describe("showHearth", () => {
  it("draws Hearth while asking, on a device that was signed in", () => {
    rememberSignedIn(true);
    expect(showHearth(undefined, true)).toBe(true);
  });

  it("waits for the answer on a device that wasn't", () => {
    expect(showHearth(undefined, true)).toBe(false);
  });

  it("goes by the server's answer once there is one", () => {
    rememberSignedIn(true);
    expect(showHearth({ signedIn: false }, false)).toBe(false);
    rememberSignedIn(false);
    expect(showHearth({ signedIn: true }, false)).toBe(true);
  });

  it("doesn't guess once asking has stopped without an answer (Hearth unreachable)", () => {
    rememberSignedIn(true);
    expect(showHearth(undefined, false)).toBe(false);
  });

  it("asks the server first when storage is off", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    expect(() => rememberSignedIn(true)).not.toThrow();
    expect(wasSignedIn()).toBe(false);
  });
});
