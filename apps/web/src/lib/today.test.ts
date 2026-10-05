// Today's sums: approvals of a kind go together and "Approve all" says plainly how it went, a
// reply that would reach someone new is caught, only Jarvis's drafts are offered, the late and
// today's tasks are told apart, and the day and Jarvis's work are read the way you'd say them.
import { describe, expect, it } from "vitest";
import {
  approvalCard,
  approveAllMessage,
  askedToSend,
  dayPlan,
  draftSnapshot,
  greeting,
  groupApprovals,
  jarvisDrafts,
  meetingState,
  nextMeeting,
  participantsOf,
  replyLine,
  sinceYesterday,
  splitDue,
  strangers,
  summary,
  toolsSaid,
} from "./today.ts";
import type {
  Approval,
  CalEvent,
  InboxRow,
  MailDraft,
  MailThreadView,
  Task,
  Turn,
} from "./types.ts";

const approval = (id: string, action: string, extra: Partial<Approval> = {}): Approval => ({
  id,
  action,
  input: {},
  risk: "outward",
  summary: `Do ${id}`,
  reason: "It reaches someone outside Hearth.",
  requestedBy: "jarvis",
  origin: "agent",
  status: "pending",
  error: null,
  conversationId: null,
  createdAt: "2026-10-05T11:00:00Z",
  ...extra,
});

describe("Needs you", () => {
  it("puts approvals of the same kind together, where the first of them was asked", () => {
    const groups = groupApprovals([
      approval("a", "mail.send"),
      approval("b", "calendar.schedule_meeting"),
      approval("c", "mail.send"),
    ]);
    expect(groups.map((g) => [g.action, g.items.map((a) => a.id)])).toEqual([
      ["mail.send", ["a", "c"]],
      ["calendar.schedule_meeting", ["b"]],
    ]);
    expect(groupApprovals(undefined)).toEqual([]);
  });

  it("says how Approve all went, and never that all went through when some didn't", () => {
    expect(approveAllMessage(["done", "done", "done"])).toEqual({ text: "3 approved.", ok: true });
    expect(approveAllMessage(["done", "changed", "done"])).toEqual({
      text: "2 approved, 1 changed — look again.",
      ok: false,
    });
    expect(approveAllMessage(["failed", "changed", "done"])).toEqual({
      text: "1 approved, 1 changed, 1 didn't go through — look again.",
      ok: false,
    });
    expect(approveAllMessage(["failed", "failed"])).toEqual({
      text: "0 approved, 2 didn't go through — look again.",
      ok: false,
    });
  });

  it("shows an approval as the inbox has it, or from the approval when the inbox hasn't", () => {
    const a = approval("a", "mail.send", {
      summary: 'Send email from me@x.example to dana@x.example: "Lease"\n\nHi Dana,\n\nYes.',
    });
    expect(approvalCard(a, undefined)).toEqual({
      what: 'Jarvis asks: Send email from me@x.example to dana@x.example: "Lease"',
      why: "It reaches someone outside Hearth.",
      text: "Hi Dana,\n\nYes.",
    });
    const row = {
      notification: { title: "Jarvis asks: Send the lease", body: "Hi Dana\n\nIt reaches out." },
    } as InboxRow;
    expect(approvalCard(a, row)).toEqual({
      what: "Jarvis asks: Send the lease",
      why: "It reaches out.",
      text: "Hi Dana",
    });
  });
});

const draft = (extra: Partial<MailDraft> = {}): MailDraft => ({
  id: "d1",
  account: "sam@x.example",
  threadId: "t1",
  to: [{ address: "dana@x.example", name: "Dana Ruiz" }],
  cc: [],
  bcc: [],
  subject: "Re: Lease",
  text: "Hi Dana",
  updatedAt: "2026-10-05T11:45:00Z",
  by: "jarvis",
  ...extra,
});

describe("Ready to send", () => {
  it("offers only the drafts Jarvis wrote", () => {
    const mine = draft({ id: "mine", by: "owner" });
    expect(jarvisDrafts([draft(), mine]).map((d) => d.id)).toEqual(["d1"]);
    expect(jarvisDrafts(undefined)).toEqual([]);
  });

  it("leaves out the drafts already waiting for your yes to send", () => {
    const asked = askedToSend([
      approval("a1", "mail.send", { input: { id: "d1", snapshot: {} } }),
      approval("a2", "calendar.schedule_meeting", { input: { id: "d2" } }),
      approval("a3", "mail.send", { input: null }),
    ]);
    expect([...asked]).toEqual(["d1"]);
    expect(askedToSend(undefined).size).toBe(0);
  });

  it("sends the draft exactly as shown, written the way Hearth checks it", () => {
    expect(
      draftSnapshot(
        draft({ cc: [{ address: "leo@x.example" }], bcc: [{ address: "me@x.example" }] }),
      ),
    ).toEqual({
      from: "sam@x.example",
      to: ["dana@x.example (Dana Ruiz)"],
      cc: ["leo@x.example"],
      bcc: ["me@x.example"],
      subject: "Re: Lease",
      text: "Hi Dana",
    });
    expect(draftSnapshot(draft({ account: null })).from).toBe("");
  });

  it("catches a reply that would reach someone who isn't in the conversation", () => {
    const thread = {
      account: "Sam@x.example",
      participants: [{ address: "dana@x.example" }],
      messages: [
        {
          from: { address: "dana@x.example" },
          to: [{ address: "sam@x.example" }],
          cc: [{ address: "Leo@X.example" }],
        },
      ],
    } as unknown as MailThreadView;
    const inThread = participantsOf(thread);
    expect([...inThread].sort()).toEqual(["dana@x.example", "leo@x.example", "sam@x.example"]);
    const reply = draft({
      to: [{ address: "DANA@x.example" }],
      cc: [{ address: "leo@x.example" }, { address: "stranger@elsewhere.example", name: "Eve" }],
      bcc: [{ address: "watcher@elsewhere.example" }],
    });
    expect([...strangers(reply, inThread)]).toEqual([
      "stranger@elsewhere.example",
      "watcher@elsewhere.example",
    ]);
    expect(strangers(draft(), inThread).size).toBe(0);
  });
});

/** Monday 5 October 2026, 10 a.m. where the test runs. */
const NOW = new Date(2026, 9, 5, 10, 0);
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).toISOString();

const task = (id: string, dueAt: string | null, dueIsDate: boolean, extra: Partial<Task> = {}) =>
  ({ id, key: `T-${id}`, title: id, status: "not_started", dueAt, dueIsDate, ...extra }) as Task;

describe("Due", () => {
  it("tells late tasks from today's, each soonest first", () => {
    const { overdue, today } = splitDue(
      [
        task("tonight", at(5, 21), false),
        task("friday", at(2, 12), true),
        task("today-date", at(5, 12), true),
        task("this-morning", at(5, 9), false),
        task("yesterday", at(4, 12), true),
        task("tomorrow", at(6, 0, 30), false),
        task("no-date", null, false),
        task("done", at(4, 12), true, { status: "completed" }),
      ],
      NOW,
    );
    expect(overdue.map((t) => t.id)).toEqual(["friday", "yesterday", "this-morning"]);
    // A day's task isn't late until the day is over, even past noon.
    expect(today.map((t) => t.id)).toEqual(["today-date", "tonight"]);
  });
});

const event = (id: string, startsAt: string, endsAt: string, extra: Partial<CalEvent> = {}) =>
  ({
    id,
    title: id,
    startsAt,
    endsAt,
    allDay: false,
    status: "confirmed",
    selfResponse: "accepted",
    selfOrganizer: false,
    recurringEventId: null,
    attendees: [],
    meetUrl: null,
    ...extra,
  }) as CalEvent;

describe("Your day", () => {
  const events = [
    event("lunch", at(5, 12, 30), at(5, 13, 30)),
    event("standup", at(5, 9, 30), at(5, 9, 45)),
    event("holiday", at(5, 0), at(6, 0), { allDay: true }),
    event("declined", at(5, 15), at(5, 16), { selfResponse: "declined" }),
    event("cancelled", at(5, 16), at(5, 17), { status: "cancelled" }),
    event("1:1", at(5, 11), at(5, 11, 30), { selfResponse: "needsAction" }),
    event("offsite", at(8, 9, 30), at(8, 16), { selfResponse: "needsAction" }),
    event("review", at(6, 14), at(6, 15), { selfResponse: "needsAction" }),
    event("mine", at(7, 14), at(7, 15), { selfResponse: "needsAction", selfOrganizer: true }),
  ];

  it("lists today's meetings in time order, and the invitations after today to answer", () => {
    const plan = dayPlan(events, NOW);
    expect(plan.today.map((e) => e.id)).toEqual(["holiday", "standup", "1:1", "lunch"]);
    expect(plan.invites.map((e) => e.id)).toEqual(["review", "offsite"]);
  });

  it("marks the meeting on now and the next one", () => {
    const { today } = dayPlan(events, new Date(2026, 9, 5, 11, 10));
    const now = new Date(2026, 9, 5, 11, 10);
    const next = nextMeeting(today, now);
    expect(next).toBe("lunch");
    expect(today.map((e) => meetingState(e, next, e.id, now))).toEqual([
      "later",
      "past",
      "now",
      "next",
    ]);
  });
});

const turn = (queuedAt: string, extra: Partial<Turn> = {}) =>
  ({ id: queuedAt, queuedAt, status: "done", reply: null, toolsUsed: [], ...extra }) as Turn;

describe("What Jarvis did", () => {
  it("keeps the turns since the start of yesterday that ran", () => {
    const turns = [
      turn(at(5, 7, 45)),
      turn(at(4, 0, 5)),
      turn(at(5, 8), { status: "skipped" }),
      turn(at(3, 23, 59)),
      turn(at(5, 9, 59), { status: "running" }),
    ];
    expect(sinceYesterday(turns, NOW).map((t) => t.queuedAt)).toEqual([
      at(5, 7, 45),
      at(4, 0, 5),
      at(5, 9, 59),
    ]);
  });

  it("says each in a line, and what it used in plain words, each once", () => {
    expect(replyLine({ reply: "\n## Drafted **two** replies\nMore below", status: "done" })).toBe(
      "Drafted two replies",
    );
    expect(replyLine({ reply: "- Booked the room", status: "done" })).toBe("Booked the room");
    expect(replyLine({ reply: null, status: "failed" })).toBe("It hit a problem and stopped.");
    expect(replyLine({ reply: null, status: "running" })).toBe("Working on it…");
    expect(toolsSaid(["mail.draft", "mail.draft", "calendar.events"])).toEqual([
      "Drafted an email",
      "Checked your calendar",
    ]);
  });
});

describe("the greeting", () => {
  it("says good morning, afternoon or evening by the clock", () => {
    expect(greeting(new Date(2026, 9, 5, 7))).toBe("Good morning");
    expect(greeting(new Date(2026, 9, 5, 13))).toBe("Good afternoon");
    expect(greeting(new Date(2026, 9, 5, 21))).toBe("Good evening");
    expect(greeting(new Date(2026, 9, 5, 2))).toBe("Good evening");
  });

  it("sums up the day under it, and says so when nothing needs you", () => {
    expect(summary({ needs: 6, meetings: 2, due: 4 })).toBe(
      "6 things need you · 2 meetings · 4 tasks due",
    );
    expect(summary({ needs: 1, meetings: 1, due: 0 })).toBe("1 thing needs you · 1 meeting");
    expect(summary({ needs: 0, meetings: 2, due: 0 })).toBe("Nothing needs you · 2 meetings");
    expect(summary({ needs: 0, meetings: 0, due: 0 })).toBe("Nothing needs you");
  });
});
