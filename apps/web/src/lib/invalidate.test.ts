import { describe, expect, it } from "vitest";
import { affectedBy, affectedByChange, type Rule, touches, union } from "./invalidate.ts";

const key = (name: string, input: unknown = {}) => [name, input] as const;
const hits = (rule: Rule | null, name: string) => rule === null || touches(rule, key(name));

describe("what a live event refreshes", () => {
  it("refreshes the inbox for inbox changes and nothing else on screen", () => {
    const rule = affectedBy({ kind: "notification.updated", payload: {} });
    expect(hits(rule, "inbox.list")).toBe(true);
    for (const other of ["mail.threads", "task.list", "note.list", "calendar.events"])
      expect(hits(rule, other)).toBe(false);
  });

  it("refreshes every mail read for mail events, and the people they're from", () => {
    const rule = affectedBy({ kind: "mail.changed", payload: {} });
    for (const name of ["mail.threads", "mail.thread", "mail.counts", "mail.search", "mail.drafts"])
      expect(hits(rule, name)).toBe(true);
    expect(hits(rule, "person.view")).toBe(true);
    expect(hits(rule, "inbox.list")).toBe(false);
    expect(hits(rule, "task.list")).toBe(false);
  });

  it("refreshes a record's own lists, plus the views that show any record", () => {
    const rule = affectedBy({ kind: "entity.updated", payload: { type: "task" } });
    for (const name of ["task.list", "task.get", "entity.get", "entity.links", "inbox.list"])
      expect(hits(rule, name)).toBe(true);
    expect(hits(rule, "note.list")).toBe(false);
    expect(hits(rule, "mail.threads")).toBe(false);
    const thread = affectedBy({ kind: "entity.created", payload: { type: "email_thread" } });
    expect(hits(thread, "mail.threads")).toBe(true);
    expect(hits(thread, "task.list")).toBe(false);
  });

  it("refreshes approvals where they show: the inbox, the list and the chat", () => {
    const rule = affectedBy({ kind: "approval.requested", payload: {} });
    for (const name of ["inbox.list", "approval.list", "conversation.get"])
      expect(hits(rule, name)).toBe(true);
  });

  it("refreshes everything for an event or record type it doesn't know", () => {
    expect(affectedBy({ kind: "brand_new.thing", payload: {} })).toBeNull();
    expect(affectedBy({ kind: "entity.updated", payload: { type: "hologram" } })).toBeNull();
    expect(affectedBy({ kind: "entity.restored", payload: {} })).toBeNull();
  });
});

describe("what a change you make refreshes", () => {
  it("refreshes its own module's reads, plus the ones it's known to touch", () => {
    const routine = affectedByChange("routine.update");
    expect(hits(routine, "routine.list")).toBe(true);
    expect(hits(routine, "system.status")).toBe(true);
    expect(hits(routine, "mail.threads")).toBe(false);
    const google = affectedByChange("google.disconnect");
    expect(hits(google, "mail.accounts")).toBe(true);
    expect(hits(google, "calendar.calendars")).toBe(true);
  });

  it("refreshes Coming up after you cancel a reminder there, when Jarvis sets one, and when one rings", () => {
    const cancel = affectedByChange("reminder.cancel");
    expect(hits(cancel, "reminder.list")).toBe(true);
    expect(hits(cancel, "system.status")).toBe(true);
    expect(hits(affectedBy({ kind: "clock.fired" }), "reminder.list")).toBe(true);
    // Jarvis setting or cancelling one shows once its turn ends.
    expect(hits(affectedBy({ kind: "jarvis.turn_finished" }), "reminder.list")).toBe(true);
  });

  it("refreshes everything after trashing a record, whose type it can't see", () => {
    expect(affectedByChange("entity.trash")).toBeNull();
  });
});

describe("rules", () => {
  it("match a module by prefix and an action by name", () => {
    expect(touches(["mail."], key("mail.thread"))).toBe(true);
    expect(touches(["mail."], key("mailbox.list"))).toBe(false);
    expect(touches(["inbox.list"], key("inbox.list", { view: "done" }))).toBe(true);
    expect(touches(["inbox.list"], key("inbox.listing"))).toBe(false);
  });

  it("join, and anything joined with everything is everything", () => {
    expect(union([["a."], ["b.c", "a."]])).toEqual(["a.", "b.c"]);
    expect(union([["a."], null])).toBeNull();
  });
});
