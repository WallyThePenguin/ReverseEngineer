import { describe, expect, it } from "vitest";
import { captureToTask, inDesktopApp, miniPage } from "./desktop.ts";

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

  it("makes a task of quick capture's text", () => {
    expect(captureToTask("  Call the bank  ")).toEqual({ title: "Call the bank" });
    expect(captureToTask("Call the bank\r\nabout the card\n")).toEqual({
      title: "Call the bank",
      body: "about the card",
    });
    expect(captureToTask(" \n ")).toBeNull();
    expect(captureToTask("x".repeat(600))?.title).toHaveLength(500);
  });
});
