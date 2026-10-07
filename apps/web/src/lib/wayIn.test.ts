import { describe, expect, it } from "vitest";
import { connectLink, wayIn, windowPasskeyHere } from "./wayIn.ts";

const TS_NET = "https://pc.example.ts.net";
const own = { origin: TS_NET, hostname: "pc.example.ts.net" };
const window = { origin: "http://localhost:4400", hostname: "localhost" };
const byNumber = { origin: "http://127.0.0.1:4400", hostname: "127.0.0.1" };

describe("wayIn", () => {
  it("offers your passkey at Hearth's own address, and when an older Hearth doesn't say", () => {
    expect(wayIn(own, { origin: TS_NET, localPasskey: true })).toBe("passkey");
    expect(wayIn(window, {})).toBe("passkey");
    // In development Hearth's own address is localhost.
    expect(wayIn(window, { origin: window.origin, localPasskey: false })).toBe("passkey");
  });

  it("offers Windows Hello in the window once it has its own passkey", () => {
    expect(wayIn(window, { origin: TS_NET, localPasskey: true })).toBe("hello");
  });

  it("otherwise sends you to your browser, never to a passkey that can't work", () => {
    expect(wayIn(window, { origin: TS_NET, localPasskey: false })).toBe("browser");
    expect(wayIn(byNumber, { origin: TS_NET, localPasskey: true })).toBe("browser");
  });
});

it("makes the window's passkey only at this PC's address by name", () => {
  expect(windowPasskeyHere(window, TS_NET)).toBe(true);
  expect(windowPasskeyHere(own, TS_NET)).toBe(false);
  expect(windowPasskeyHere(byNumber, TS_NET)).toBe(false);
  expect(windowPasskeyHere(window, window.origin)).toBe(false);
});

it("connects from the browser at Settings, Desktop app", () => {
  expect(connectLink(TS_NET)).toBe(`${TS_NET}/settings?connect=desktop`);
});
