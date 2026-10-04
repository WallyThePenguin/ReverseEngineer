import { describe, expect, it } from "vitest";
import { captureToTask, inDesktopApp, miniPage, pageLink, whenShownAgain } from "./desktop.ts";

const EDGE =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0";

describe("Hearth's Windows app", () => {
  it("knows its window by the user agent", () => {
    expect(inDesktopApp(`${EDGE} HearthDesktop/1.0.42`)).toBe(true);
    expect(inDesktopApp(EDGE)).toBe(false);
    expect(inDesktopApp(`${EDGE} NotHearthDesktop/1`)).toBe(false);
  });

  it("opens the small windows' pages, and leaves the rest to the app", () => {
    expect(miniPage({ pathname: "/capture", search: "" })).toBe("capture");
    expect(miniPage({ pathname: "/capture/", search: "" })).toBe("capture");
    expect(miniPage({ pathname: "/chat", search: "?compact=1" })).toBe("ask");
    expect(miniPage({ pathname: "/chat", search: "" })).toBeNull();
    expect(miniPage({ pathname: "/inbox", search: "?compact=1" })).toBeNull();
    expect(miniPage({ pathname: "/", search: "" })).toBeNull();
  });

  it("sends pages a small window has no room for to Hearth's main window", () => {
    const here = { origin: "http://localhost:4400", href: "http://localhost:4400/chat?compact=1" };
    const id = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
    expect(pageLink(`/task/${id}`, here, true)).toBe(`hearth://open/task/${id}`);
    expect(pageLink(`/inbox+note/${id}`, here, true)).toBe(`hearth://open/inbox+note/${id}`);
    // In a browser, this tab opens it.
    expect(pageLink(`/task/${id}`, here, false)).toBe(`/task/${id}`);
    // Only Hearth's own pages.
    expect(pageLink("https://example.com/x", here, true)).toBeNull();
    expect(pageLink("//example.com/x", here, true)).toBeNull();
  });

  it("makes a task of quick capture's text", () => {
    expect(captureToTask("  Call the bank  ")).toEqual({ title: "Call the bank" });
    expect(captureToTask("Call the bank\r\nabout the card\n")).toEqual({
      title: "Call the bank",
      body: "about the card",
    });
    expect(captureToTask(" \n ")).toBeNull();
    expect(captureToTask("x".repeat(600))?.title).toHaveLength(500);
  });

  it("has a kept small window look again when it's shown, until it can show your Hearth", () => {
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), {
      visibilityState: "hidden" as DocumentVisibilityState,
    });
    let signedIn = false;
    let checks = 0;
    const stop = whenShownAgain(
      () => !signedIn,
      () => {
        checks += 1;
      },
      win,
      doc,
    );
    // Tucked away: nothing to do.
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(checks).toBe(0);
    // Shown again, whichever way WebView2 says so.
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    win.dispatchEvent(new Event("focus"));
    expect(checks).toBe(2);
    // Signed in: nothing more to look at.
    signedIn = true;
    win.dispatchEvent(new Event("focus"));
    expect(checks).toBe(2);
    signedIn = false;
    stop();
    win.dispatchEvent(new Event("focus"));
    expect(checks).toBe(2);
  });
});
