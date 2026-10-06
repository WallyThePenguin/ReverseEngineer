// An iPhone in Safari is told the one step that lets Hearth notify it, rather than shown a button
// that can't work; everywhere else, notifications are the browser's own or the Windows app's.
import { describe, expect, it } from "vitest";
import { alertsHere } from "./alertsHere.ts";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";
const IPAD_AS_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";
const EDGE =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0";

const on = (ua: string, more: Partial<Parameters<typeof alertsHere>[0]> = {}) =>
  alertsHere({ ua, touchPoints: 0, standalone: false, push: false, ...more });

describe("notifications on this device", () => {
  it("need the Home Screen on an iPhone or iPad in Safari", () => {
    expect(on(IPHONE, { touchPoints: 5 })).toBe("home-screen");
    expect(on(IPAD_AS_MAC, { touchPoints: 5 })).toBe("home-screen");
  });

  it("are the browser's own once Hearth is opened from the Home Screen", () => {
    expect(on(IPHONE, { touchPoints: 5, standalone: true, push: true })).toBe("push");
    // An iOS too old for web notifications: nothing to offer.
    expect(on(IPHONE, { touchPoints: 5, standalone: true })).toBe("none");
  });

  it("are the browser's own elsewhere, and the Windows app's in it", () => {
    expect(on(ANDROID, { touchPoints: 5, push: true })).toBe("push");
    expect(on(IPAD_AS_MAC, { push: true })).toBe("push");
    expect(on(EDGE, { push: true })).toBe("push");
    expect(on(`${EDGE} HearthDesktop/1.0.21`, { push: true })).toBe("desktop");
  });

  it("aren't asked of a Mac or PC browser that can't take them", () => {
    expect(on(IPAD_AS_MAC)).toBe("none");
    expect(on(EDGE)).toBe("none");
  });
});
