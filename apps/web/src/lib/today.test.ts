// Today's sums: only Jarvis's drafts are offered, a reply drafted above isn't listed again as owed,
// the late and today's tasks are told apart (yours, not Jarvis's), and the day and Jarvis's work
// are read the way you'd say them. What needs your yes is in needsYou.test.ts.
import { describe, expect, it } from "vitest";
import {
  dayPlan,
  draftSnapshot,
  greeting,
  jarvisDrafts,
  meetingState,
  nextMeeting,
  offerAsTask,
  owed,
  sinceYesterday,
  splitDue,
  summary,
  toolsSaid,
} from "./today.ts";
import type { CalEvent, MailDraft, MailThread, Task, Turn } from "./types.ts";

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

  it("lists as owed only the replies nobody has drafted yet, and counts the rest", () => {
    const thread = (id: string) => ({ id }) as MailThread;
    const waiting = ["a", "b", "c", "d", "e", "f", "g"].map(thread);
    const { rows, drafted } = owed(waiting, new Set(["b", "d", "x"]));
    expect(rows.map((t) => t.id)).toEqual(["a", "c", "e", "f", "g"]);
    expect(drafted).toBe(2);
    expect(owed(waiting, new Set(), 3).rows.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(owed(undefined, new Set())).toEqual({ rows: [], drafted: 0 });
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
        // Jarvis's own, as the brief leaves them out; yours and nobody's stay.
        task("jarvis", at(4, 12), true, { assignee: "jarvis" }),
        task("yours", at(5, 18), false, { assignee: "owner" }),
      ],
      NOW,
    );
    expect(overdue.map((t) => t.id)).toEqual(["friday", "yesterday", "this-morning"]);
    // A day's task isn't late until the day is over, even past noon.
    expect(today.map((t) => t.id)).toEqual(["today-date", "yours", "tonight"]);
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
    ownCalendar: true,
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
    // A colleague's invitation, on their calendar shared with you: not yours to answer.
    event("ana's", at(6, 10), at(6, 11), { selfResponse: "needsAction", ownCalendar: false }),
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
  ({
    id: queuedAt,
    queuedAt,
    status: "done",
    outcome: "tell",
    reply: "Done.",
    writes: 0,
    toolsUsed: [],
    origin: "system",
    ...extra,
  }) as Turn;

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

  it("leaves out turns that came to nothing, and keeps a stopped one that did something", () => {
    const turns = [
      // A look round that found nothing to do.
      turn(at(5, 8, 25), { outcome: "nothing", reply: null }),
      turn(at(5, 8, 50), { outcome: "nothing", reply: "  " }),
      // Stopped before it did or said anything.
      turn(at(5, 9), { status: "canceled", outcome: null, reply: null }),
      // Stopped after it drafted something: that's worth knowing.
      turn(at(5, 9, 5), { status: "canceled", outcome: null, reply: null, writes: 1 }),
      // Found nothing to do, but said so in words.
      turn(at(5, 9, 10), { outcome: "nothing", reply: "Nothing new in your inbox." }),
    ];
    expect(sinceYesterday(turns, NOW).map((t) => t.queuedAt)).toEqual([at(5, 9, 5), at(5, 9, 10)]);
  });

  it("says what a turn used in plain words, each once", () => {
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

  it("sums up the day under it, each part counting what its section shows", () => {
    const line = (n: Parameters<typeof summary>[0]) =>
      summary(n)
        .map((p) => `${p.text} > ${p.to}`)
        .join(" · ");
    expect(line({ approvals: 3, ready: 3, meetings: 2, due: 4 })).toBe(
      "3 need your yes > today-needs · 3 ready to send > today-drafts · 2 meetings > today-day · 4 tasks due > today-due",
    );
    expect(line({ approvals: 1, ready: 0, meetings: 1, due: 0 })).toBe(
      "1 needs your yes > today-needs · 1 meeting > today-day",
    );
    expect(line({ approvals: 0, ready: 2, meetings: 0, due: 1 })).toBe(
      "2 ready to send > today-drafts · 1 task due > today-due",
    );
    expect(line({ approvals: 0, ready: 0, meetings: 2, due: 0 })).toBe(
      "Nothing needs you > today-needs · 2 meetings > today-day",
    );
    // Not "Nothing needs you" while what needs you is still being read, or couldn't be.
    expect(line({ approvals: null, ready: 0, meetings: 2, due: 0 })).toBe("2 meetings > today-day");
    expect(line({ approvals: 0, ready: null, meetings: 0, due: 0 })).toBe("");
  });
});

describe("The Ask box", () => {
  const now = new Date(2026, 9, 7, 9, 0); // a Wednesday morning

  it("offers a line that names a time as a task, without the words that said when", () => {
    const w = offerAsTask("dentist fri 3pm", now);
    expect(w?.title).toBe("dentist");
    expect(new Date(w?.dueAt ?? "")).toEqual(new Date(2026, 9, 9, 15, 0));
  });

  it("leaves a question for Jarvis, even one that names a day", () => {
    expect(offerAsTask("what's on friday?", now)).toBeNull();
    expect(offerAsTask("  am I free at 3pm?  ", now)).toBeNull();
  });

  it("offers nothing when no time is named, or nothing is typed", () => {
    expect(offerAsTask("plan my week", now)).toBeNull();
    expect(offerAsTask("   ", now)).toBeNull();
  });
});
