import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALLOWED,
  answersItself,
  checkCommand,
  Dialogs,
  PROTOCOL,
} from "../../../../apps/extension/rules.js";
import { BRIDGE_PROTOCOL, EXTENSION_ID } from "./protocol.ts";

const root = new URL("../../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

describe("the extension's rules (D24, D52)", () => {
  it("agree with the server on the protocol and the extension's ID", () => {
    expect(PROTOCOL).toBe(BRIDGE_PROTOCOL);
    const manifest = JSON.parse(read("apps/extension/manifest.json")) as { key: string };
    const digest = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex");
    const id = [...digest.slice(0, 32)].map((c) =>
      String.fromCharCode(97 + Number.parseInt(c, 16)),
    );
    expect(id.join("")).toBe(EXTENSION_ID);
  });

  it("refuse commands off the list, other addresses, and scripts outside Hearth's worlds", () => {
    expect(() => checkCommand("Network.getCookies", {}, undefined)).toThrow(/isn't something/);
    expect(() => checkCommand("Storage.clearDataForOrigin", {}, undefined)).toThrow();
    expect(() =>
      checkCommand("Page.navigate", { url: "file:///C:/secrets.txt" }, undefined),
    ).toThrow(/http and https/);
    expect(() =>
      checkCommand("Page.navigate", { url: "https://ok.example/" }, undefined),
    ).not.toThrow();
    expect(() => checkCommand("Runtime.evaluate", { contextId: 1 }, new Set([2]))).toThrow(
      /isolated/,
    );
    expect(() => checkCommand("Runtime.evaluate", { contextId: 2 }, new Set([2]))).not.toThrow();
  });

  it("let only the answer through while a dialog is open, and fail calls waiting on one", async () => {
    const d = new Dialogs();
    let release = () => {};
    const waiting = d.guard(
      1,
      "Input.dispatchMouseEvent",
      () => new Promise<void>((r) => (release = r)),
    );
    d.opened(1, { type: "confirm", message: "Sure?", url: "https://a.example/" });
    await expect(waiting).rejects.toMatchObject({ code: "dialog_open" });
    await expect(d.guard(1, "Runtime.evaluate", async () => 1)).rejects.toMatchObject({
      code: "dialog_open",
    });
    // The page's own words stay out of the error.
    const err = await d.guard(1, "Runtime.evaluate", async () => 1).catch((e: Error) => e);
    expect(String(err)).toMatch(/A confirm dialog is open/);
    expect(String(err)).not.toMatch(/Sure/);
    expect(await d.guard(1, "Page.handleJavaScriptDialog", async () => "answered")).toBe(
      "answered",
    );
    d.closed(1);
    expect(await d.guard(1, "Runtime.evaluate", async () => 2)).toBe(2);
    expect(await d.guard(2, "Runtime.evaluate", async () => 3)).toBe(3);
    release();
  });

  it("answer 'leave site?' by themselves only while navigating Jarvis's own tab", () => {
    const leave = { type: "beforeunload", message: "", url: "https://a.example/" };
    expect(answersItself(leave, { navigating: true, own: true })).toBe(true);
    expect(answersItself(leave, { navigating: true, own: false })).toBe(false);
    expect(answersItself(leave, { navigating: false, own: true })).toBe(false);
    expect(answersItself({ ...leave, type: "confirm" }, { navigating: true, own: true })).toBe(
      false,
    );
  });
});

/** Every .ts file under a folder, tests left out. */
function sources(dir: string): string[] {
  const path = new URL(dir, root);
  return readdirSync(path).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(new URL(full, root)).isDirectory()) return sources(`${full}/`);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [full] : [];
  });
}

// Events Hearth listens for, which aren't commands it sends.
const EVENTS = new Set([
  "Page.screencastFrame",
  "Page.javascriptDialogOpening",
  "Page.javascriptDialogClosed",
  "Hearth.detached",
]);

describe("what Hearth sends Chrome", () => {
  it("is all on the extension's list", () => {
    const files = [
      ...sources("packages/modules/src/browser/"),
      ...sources("apps/server/src/browser/"),
    ];
    expect(files.length).toBeGreaterThan(10);
    const named = new Set<string>();
    for (const file of files)
      for (const m of read(file).matchAll(/"((?:[A-Z][a-zA-Z]+)\.[a-z][a-zA-Z]+)"/g))
        if (
          /^(Page|Runtime|Input|Emulation|DOM|Network|Storage|Browser|Target|Accessibility|Log|Fetch|Hearth)\./.test(
            m[1]!,
          )
        )
          named.add(m[1]!);
    const sent = [...named].filter((m) => !EVENTS.has(m));
    expect(sent.length).toBeGreaterThan(10);
    expect(sent.filter((m) => !ALLOWED.has(m))).toEqual([]);
  });
});
