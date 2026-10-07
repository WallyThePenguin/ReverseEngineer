import { describe, expect, it } from "vitest";
import { connectLink, wayIn, windowPasskeyHere } from "./wayIn.ts";

const TS_NET = "https://pc.example.ts.net";
const own = { origin: TS_NET, hostname: "pc.example.ts.net" };
const window = { origin: "http://localhost:4400", hostname: "localhost" };
const byNumber = { origin: "http://127.0.0.1:4400", hostname: "127.0.0.1" };
const set = { needsSetup: false, origin: TS_NET };

describe("wayIn", () => {
  it("offers your passkey at Hearth's own address, and when an older Hearth doesn't say", () => {
    expect(wayIn(own, { ...set, localPasskey: true }, false)).toBe("passkey");
    expect(wayIn(window, { needsSetup: false }, true)).toBe("passkey");
    // In development Hearth's own address is localhost.
    expect(wayIn(window, { ...set, origin: window.origin }, true)).toBe("passkey");
  });

  it("offers Windows Hello only in the app's window, once it has its own passkey", () => {
    expect(wayIn(window, { ...set, localPasskey: true }, true)).toBe("hello");
    // Chrome or Edge at the same address would sign the window out.
    expect(wayIn(window, { ...set, localPasskey: true }, false)).toBe("browser");
  });

  it("otherwise sends you to your browser, never to a passkey that can't work", () => {
    expect(wayIn(window, { ...set, localPasskey: false }, true)).toBe("browser");
    expect(wayIn(byNumber, { ...set, localPasskey: true }, true)).toBe("browser");
  });

  it("takes the setup code only at Hearth's own address", () => {
    expect(wayIn(own, { needsSetup: true, origin: TS_NET }, false)).toBe("setup");
    expect(wayIn(window, { needsSetup: true }, true)).toBe("setup");
    expect(wayIn(window, { needsSetup: true, origin: TS_NET }, true)).toBe("browser");
  });
});

it("makes the window's passkey only in the app, at this PC's address by name", () => {
  expect(windowPasskeyHere(window, TS_NET, true)).toBe(true);
  expect(windowPasskeyHere(window, TS_NET, false)).toBe(false);
  expect(windowPasskeyHere(own, TS_NET, true)).toBe(false);
  expect(windowPasskeyHere(byNumber, TS_NET, true)).toBe(false);
  expect(windowPasskeyHere(window, window.origin, true)).toBe(false);
});

it("connects from the browser at Settings, Desktop app", () => {
  expect(connectLink(TS_NET)).toBe(`${TS_NET}/settings?connect=desktop`);
});
