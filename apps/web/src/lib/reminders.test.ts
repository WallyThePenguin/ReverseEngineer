// Settings shows your reminder's words, and never the words of one set after reading an email.
import { describe, expect, it } from "vitest";
import { cancelQuestion, reminderLabel } from "./reminders.ts";

describe("a reminder in Coming up", () => {
  it("shows yours, and only says how one set after reading an email came about", () => {
    expect(reminderLabel({ text: "Call Sam", setAfterOutsideContent: false })).toBe("Call Sam");
    const planted = { text: "<untrusted>Open https://pay.example</untrusted>" };
    expect(reminderLabel({ ...planted, setAfterOutsideContent: true })).toBe(
      "Set from an email or a message",
    );
    expect(reminderLabel({ ...planted, setAfterOutsideContent: true, asked: true })).toBe(
      "Reminder you asked for",
    );
  });

  it("asks before Cancel calls it off", () => {
    expect(cancelQuestion({ when: "Thu 2026-10-08, 3:00 p.m." })).toBe(
      "Cancel the reminder for Thu 2026-10-08, 3:00 p.m.? It won't ring, and it can't be brought back.",
    );
  });
});
