import { describe, expect, it } from "vitest";
import {
  applyDictionary,
  expandSnippets,
  learnedSwaps,
  pickStyle,
  rulesPass,
  tidy,
} from "./clean.ts";

describe("cleanup rules", () => {
  it("drops fillers, false starts and repeats", () => {
    expect(tidy("um so I think uh we should ship it")).toBe("So I think we should ship it");
    expect(tidy("let's meet on Monday. no wait scratch that. let's meet Tuesday")).toBe(
      "Let's meet on Monday. Let's meet Tuesday",
    );
    expect(tidy("send it to the the team , please")).toBe("Send it to the team, please");
    expect(tidy("Book the room scratch that book the hall")).toBe("Book the hall");
    // Words that only start like a filler stay.
    expect(tidy("the umbrella is here")).toBe("The umbrella is here");
  });

  it("spells your words your way, longest first", () => {
    const dict = [
      { heard: "auto pair", write: "OtoPair" },
      { heard: "pair", write: "PAIR" },
      { heard: null, write: "Hearth" },
    ];
    expect(applyDictionary("Open auto pair and pair it", dict)).toBe("Open OtoPair and PAIR it");
    expect(applyDictionary("repair stays", dict)).toBe("repair stays");
  });

  it("expands snippets and keeps their text exactly", () => {
    const text = expandSnippets("Here's my calendar link.", [
      { trigger: "my calendar link", text: "https://cal.example/w?$1" },
    ]);
    expect(text).toBe("Here's https://cal.example/w?$1.");
    // A snippet whose text says another's trigger isn't expanded again.
    const loop = [
      { trigger: "alpha", text: "beta beta" },
      { trigger: "beta", text: "alpha alpha" },
    ];
    expect(expandSnippets("alpha", loop)).toBe("beta beta");
  });

  it("picks the style for the app you're in", () => {
    const styles = [
      { name: "Slack", match: "slack", instructions: "casual" },
      { name: "Email", match: "Gmail", instructions: "formal" },
    ];
    expect(pickStyle(styles, "chrome.exe", "Inbox - Gmail")?.name).toBe("Email");
    expect(pickStyle(styles, "Slack.exe", null)?.name).toBe("Slack");
    expect(pickStyle(styles, "notepad.exe", "Untitled")).toBeNull();
  });

  it("runs the whole rules pass", () => {
    expect(rulesPass("um open auto pair", [{ heard: "auto pair", write: "OtoPair" }], [])).toBe(
      "Open OtoPair",
    );
  });

  it("learns word swaps from your fixes, not rewrites", () => {
    expect(learnedSwaps("Ship it to Otto pair today.", "Ship it to OtoPair today.")).toEqual([
      { heard: "Otto pair", write: "OtoPair" },
    ]);
    expect(learnedSwaps("Ship it today.", "Ship it today.")).toEqual([]);
    expect(learnedSwaps("One two three four five", "Six seven eight nine ten")).toEqual([]);
  });
});
