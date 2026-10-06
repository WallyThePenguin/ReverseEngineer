// A device signed in lately draws Hearth at once; the server's answer always wins, and only it
// opens the notes kept on the device.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberSignedIn, showHearth, wasSignedIn } from "./signedIn.ts";

const DAY = 86_400_000;

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
  it("draws Hearth before the answer, on a device that was signed in", () => {
    rememberSignedIn(true);
    expect(showHearth(undefined)).toBe(true);
  });

  it("waits for the answer on a device that wasn't", () => {
    expect(showHearth(undefined)).toBe(false);
  });

  it("goes by the server's answer once there is one", () => {
    rememberSignedIn(true);
    expect(showHearth({ signedIn: false })).toBe(false);
    rememberSignedIn(false);
    expect(showHearth({ signedIn: true })).toBe(true);
  });

  it("stops guessing once the sign-in could have ended on the server", () => {
    rememberSignedIn(true);
    expect(wasSignedIn(Date.now() + 29 * DAY)).toBe(true);
    expect(wasSignedIn(Date.now() + 31 * DAY)).toBe(false);
    // What was kept before it had a time.
    store.set("hearth.signed-in", "1");
    expect(wasSignedIn()).toBe(false);
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

describe("signInConfirmed", () => {
  const settled = async (p: Promise<void>) => {
    let done = false;
    void p.then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 0));
    return done;
  };

  it("waits for the server, not the guess, and again after a sign-out", async () => {
    // As the page starts: nothing answered yet.
    vi.resetModules();
    const fresh = await import("./signedIn.ts");
    store.set("hearth.signed-in", String(Date.now()));
    expect(fresh.showHearth(undefined)).toBe(true);
    expect(await settled(fresh.signInConfirmed())).toBe(false);
    fresh.rememberSignedIn(true);
    expect(await settled(fresh.signInConfirmed())).toBe(true);
    fresh.rememberSignedIn(false);
    expect(await settled(fresh.signInConfirmed())).toBe(false);
    fresh.rememberSignedIn(true);
    expect(await settled(fresh.signInConfirmed())).toBe(true);
  });
});
