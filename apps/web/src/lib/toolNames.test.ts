import { describe, expect, it } from "vitest";
import { toolDoing, toolSentence } from "./toolNames.ts";

describe("toolSentence", () => {
  it("says what Jarvis did in words, as it happens and once it's done", () => {
    expect(toolSentence("mail.draft", "running")).toBe("Drafting an email…");
    expect(toolSentence("mail.draft", "done")).toBe("Drafted an email");
    expect(toolSentence("calendar.schedule_meeting", "done")).toBe("Invited people to a meeting");
  });

  it("says it asked first while an approval waits, and when it failed", () => {
    expect(toolSentence("mail.send", "pending_approval")).toBe("Asked before sending an email");
    expect(toolSentence("mail.send", "done", true)).toBe("Sending an email failed");
  });

  it("reads the names older conversations logged", () => {
    expect(toolSentence("mcp__hearth__mail_draft", "done")).toBe("Drafted an email");
    expect(toolSentence("mcp__hearth__calendar_schedule_meeting", "done")).toBe(
      "Invited people to a meeting",
    );
  });

  it("says what a kind of action does, for a group of approvals asking for it", () => {
    expect(toolDoing("mail.send")).toBe("Sending an email");
    expect(toolDoing("calendar.respond")).toBe("Answering an invitation");
    expect(toolDoing("standing_rule.create")).toBe("Using standing rule create");
  });

  it("names any other tool in plain words", () => {
    expect(toolSentence("dictionary.add", "done")).toBe("Used dictionary add");
    expect(toolSentence("standing_rule.list", "running")).toBe("Using standing rule list…");
    expect(toolSentence("standing_rule.list", "pending_approval")).toBe(
      "Asked before using standing rule list",
    );
  });
});
