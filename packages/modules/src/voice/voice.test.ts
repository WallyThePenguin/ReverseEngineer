import { type Caller, jarvisCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL_MODULES } from "../index.ts";
import { POLISH_SERVICE, type Polisher, plausible } from "./polish.ts";

let t: TestKernel;
beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
});
afterEach(() => t.destroy());

async function ok<T>(name: string, input: unknown = {}, caller: Caller = ownerCaller()) {
  const res = await t.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
type Cleaned = { id: string | null; text: string; style: string | null };
type Dictated = { id: string; text: string; raw: string; app: string | null; polished: boolean };

describe("dictation", () => {
  it("cleans speech with your dictionary and snippets, and keeps it in the history", async () => {
    await ok("dictionary.add", { heard: "auto pair", write: "OtoPair" });
    await ok("snippet.save", { trigger: "my calendar link", text: "https://cal.example/w" });
    const r = await ok<Cleaned>("voice.clean", {
      raw: "um can you uh open auto pair and send them my calendar link",
      app: "Slack.exe",
      durationMs: 3200,
    });
    expect(r.text).toBe("Can you open OtoPair and send them https://cal.example/w");
    expect(r.style).toBe("Chat");
    const list = await ok<Dictated[]>("dictation.list", { query: "otopair" });
    expect(list).toMatchObject([{ id: r.id, app: "Slack.exe", polished: false }]);
    expect(list[0]!.raw).toContain("auto pair");
  });

  it("uses the local model when it's there, but never for snippet text", async () => {
    const calls: { text: string; style: string | null }[] = [];
    const fake: Polisher = {
      async polish(text, o) {
        calls.push({ text, style: o.style });
        return `${text.replace(/^Send/, "Please send")}.`;
      },
    };
    t.kernel.services[POLISH_SERVICE] = fake;
    await ok("snippet.save", { trigger: "my address", text: "1 Main St" });
    const r = await ok<Cleaned>("voice.clean", {
      raw: "send it to my address",
      app: "chrome.exe",
      window: "Inbox - Gmail",
    });
    expect(r.text).toBe("Please send it to 1 Main St.");
    expect(calls).toEqual([
      { text: "Send it to my address", style: "Clear, friendly full sentences." },
    ]);
    // A model that wanders off is ignored.
    expect(plausible("Send it", "Sure! Here is a cleaned up version of your text: Send it")).toBe(
      false,
    );
  });

  it("learns spellings from your fixes", async () => {
    const r = await ok<Cleaned>("voice.clean", { raw: "ship it to otto pair today" });
    const fixed = await ok<{ learned: unknown[] }>("dictation.fix", {
      id: r.id,
      text: "Ship it to OtoPair today",
    });
    expect(fixed.learned).toEqual([{ heard: "otto pair", write: "OtoPair" }]);
    const again = await ok<Cleaned>("voice.clean", { raw: "is otto pair live" });
    expect(again.text).toBe("Is OtoPair live");
  });

  it("previews without saving, keeps styles you set, and stays yours", async () => {
    const r = await ok<Cleaned>("voice.clean", { raw: "hello", save: false });
    expect(r).toMatchObject({ id: null, text: "Hello" });
    expect(await ok<unknown[]>("dictation.list")).toEqual([]);
    await ok("voice.set_styles", {
      styles: [{ name: "Code", match: "code.exe", instructions: "Keep code terms as said." }],
    });
    expect(await ok<{ name: string }[]>("voice.styles")).toMatchObject([{ name: "Code" }]);
    for (const [name, input] of [
      ["voice.clean", { raw: "x" }],
      ["dictionary.add", { write: "Hearth" }],
      ["snippet.save", { trigger: "hi there", text: "x" }],
    ] as const) {
      expect(await t.kernel.execute(name, input, jarvisCaller("agent"))).toMatchObject({
        status: "denied",
      });
    }
    await ok("snippet.save", { trigger: "Sign off", text: "Thanks" });
    expect(
      await t.kernel.execute("snippet.save", { trigger: "sign off", text: "x" }, ownerCaller()),
    ).toMatchObject({ code: "conflict" });
  });
});
