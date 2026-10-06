// What needs your yes: approvals of a kind go together, but a send that would reach someone new
// (or that can't be checked yet) is approved on its own; and "Approve all" says plainly how it
// went, naming each one that didn't go through and why.
import { describe, expect, it } from "vitest";
import {
  approvalCard,
  approveAllResult,
  askedToSend,
  askRow,
  coverable,
  groupApprovals,
  mailTitle,
  namesOf,
  ownWhy,
  participantsOf,
  SHARED_WHY,
  sendReach,
  sendRecipients,
  strangers,
} from "./needsYou.ts";
import type { Approval, InboxRow, MailDraft, MailThreadView } from "./types.ts";

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

/** A send of draft `draftId` as Jarvis asks for it: what a yes sends, address first. */
const send = (id: string, draftId: string, to: string[], cc: string[] = []) =>
  approval(id, "mail.send", {
    input: {
      id: draftId,
      snapshot: { from: "sam@x.example", to, cc, bcc: [], subject: `Re: ${id}`, text: "Hi" },
    },
  });

const draft = (id: string, threadId: string | null): MailDraft => ({
  id,
  account: "sam@x.example",
  threadId,
  to: [{ address: "dana@x.example" }],
  cc: [],
  bcc: [],
  subject: "Re: Lease",
  text: "Hi Dana",
  updatedAt: "2026-10-05T11:45:00Z",
  by: "jarvis",
});

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

describe("grouping what needs your yes", () => {
  it("puts approvals of the same kind together, where the first of them was asked", () => {
    const groups = groupApprovals([
      approval("a", "mail.send"),
      approval("b", "calendar.schedule_meeting"),
      approval("c", "mail.send"),
    ]);
    expect(groups.map((g) => [g.key, g.items.map((a) => a.id)])).toEqual([
      ["mail.send", ["a", "c"]],
      ["calendar.schedule_meeting", ["b"]],
    ]);
    expect(groupApprovals(undefined)).toEqual([]);
  });

  it("gives one that has to be approved on its own a group of its own", () => {
    const list = [send("a", "d1", []), send("b", "d2", []), send("c", "d3", [])];
    const groups = groupApprovals(list, (a) => a.id === "b");
    expect(groups.map((g) => [g.key, g.items.map((a) => a.id)])).toEqual([
      ["mail.send", ["a", "c"]],
      ["mail.send#b", ["b"]],
    ]);
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

describe("who a send would reach", () => {
  it("knows which drafts already wait for your yes to send", () => {
    const asked = askedToSend([
      send("a1", "d1", []),
      approval("a2", "calendar.schedule_meeting", { input: { id: "d2" } }),
      approval("a3", "mail.send", { input: null }),
    ]);
    expect([...asked]).toEqual(["d1"]);
    expect(askedToSend(undefined).size).toBe(0);
  });

  it("reads who it goes to from what a yes would send, address first", () => {
    const a = send("a", "d1", ["dana@x.example (Dana Ruiz (Home))", "leo@x.example"]);
    expect(sendRecipients(a)).toEqual({
      to: [{ address: "dana@x.example", name: "Dana Ruiz (Home)" }, { address: "leo@x.example" }],
      cc: [],
      bcc: [],
    });
    expect(sendRecipients(approval("b", "mail.send", { input: { id: "d1" } }))).toBe(null);
  });

  it("catches a reply that would reach someone who isn't in the conversation", () => {
    const inThread = participantsOf(thread);
    expect([...inThread].sort()).toEqual(["dana@x.example", "leo@x.example", "sam@x.example"]);
    const reply = {
      to: [{ address: "DANA@x.example" }],
      cc: [{ address: "leo@x.example" }, { address: "stranger@elsewhere.example", name: "Eve" }],
      bcc: [{ address: "watcher@elsewhere.example" }],
    };
    expect([...strangers(reply, inThread)]).toEqual([
      "stranger@elsewhere.example",
      "watcher@elsewhere.example",
    ]);
  });

  it("lets Approve all cover only a reply that stays within its conversation", () => {
    const drafts = [draft("d1", "t1"), draft("d2", null)];
    const threads = (id: string) => (id === "t1" ? thread : undefined);
    const inside = sendReach(send("a", "d1", ["dana@x.example (Dana)"]), drafts, threads);
    expect(inside).toEqual({ kind: "reply", strangers: new Set() });
    expect(coverable(inside)).toBe(true);
    // Someone new on it: marked, and approved on its own.
    const outside = sendReach(
      send("b", "d1", ["dana@x.example"], ["ceo@yourco.example (Dana)"]),
      drafts,
      threads,
    );
    expect(outside).toEqual({ kind: "reply", strangers: new Set(["ceo@yourco.example"]) });
    expect(coverable(outside)).toBe(false);
    // A new email: everyone on it is someone new.
    expect(sendReach(send("c", "d2", ["x@y.example"]), drafts, threads)).toEqual({ kind: "new" });
    // Its draft or conversation not read yet: not covered until it is.
    expect(sendReach(send("d", "d1", []), undefined, threads)).toEqual({ kind: "unknown" });
    expect(sendReach(send("e", "d1", []), drafts, () => undefined)).toEqual({ kind: "unknown" });
    expect(coverable({ kind: "new" })).toBe(false);
    expect(coverable({ kind: "unknown" })).toBe(false);
  });
});

describe("what Approve all says", () => {
  it("says how it went, and never that all went through when some didn't", () => {
    const [a, b, c] = [send("a", "d1", []), send("b", "d2", []), approval("c", "task.delete")];
    const done = (x: Approval) => ({ approval: x, outcome: "done" as const, message: null });
    expect(approveAllResult([done(a), done(b), done(c)])).toEqual({
      text: "3 approved.",
      ok: true,
      missed: [],
    });
    const changed = "The draft changed since you were asked, so nothing was sent.";
    expect(
      approveAllResult([
        done(a),
        { approval: b, outcome: "changed", message: changed },
        { approval: c, outcome: "failed", message: null },
      ]),
    ).toEqual({
      text: "1 approved, 2 didn't go through:",
      ok: false,
      missed: [
        { id: "b", label: "“Re: b”", why: changed, draftId: "d2" },
        { id: "c", label: "Do c", why: "Hearth couldn't do it.", draftId: null },
      ],
    });
    expect(approveAllResult([{ approval: a, outcome: "changed", message: null }])).toMatchObject({
      text: "1 didn't go through:",
      missed: [{ why: "It changed before your yes reached it." }],
    });
  });
});

describe("each as a row", () => {
  it("names people as a row says them, with the rest counted", () => {
    expect(namesOf([{ address: "dana@x.example", name: "Dana Ruiz" }])).toBe("Dana Ruiz");
    expect(
      namesOf([{ address: "leo@x.example" }, { address: "pri@x.example", name: " Priya " }]),
    ).toBe("leo@x.example and Priya");
    expect(namesOf([{ address: "a@x" }, { address: "b@x" }, { address: "c@x" }])).toBe(
      "a@x and 2 others",
    );
    expect(mailTitle([], null)).toBe("Send to nobody yet");
  });

  it("says a send as a reply or a new email to its people, by name, with its subject", () => {
    const a = send("lease", "d1", ["dana@x.example (Dana Ruiz)"]);
    const parts = {
      what: "Jarvis asks: Send email from sam@x.example to dana@x.example",
      text: "Hi",
    };
    expect(askRow(a, parts, true)).toEqual({
      title: "Reply to Dana Ruiz",
      sub: "Re: lease",
      whole: false,
    });
    expect(askRow(a, parts, false).title).toBe("Email Dana Ruiz");
    expect(askRow(a, parts, null).title).toBe("Send to Dana Ruiz");
  });

  it("puts a yes on the row only when the row shows all of it", () => {
    const invite = approval("i", "calendar.schedule_meeting");
    expect(
      askRow(invite, { what: 'Jarvis asks: Invite pri@x.example to "Prep"', text: null }, null),
    ).toEqual({ title: 'Invite pri@x.example to "Prep"', sub: null, whole: true });
    expect(askRow(invite, { what: "Jarvis asks: Post it", text: "The post" }, null).whole).toBe(
      false,
    );
    // Someone other than Jarvis asking keeps their name on it.
    const outside = approval("o", "task.create", { requestedBy: "mcp:notes-app" });
    expect(askRow(outside, { what: "notes-app asks: Add a task", text: null }, null).title).toBe(
      "notes-app asks: Add a task",
    );
  });

  it("says the usual reason once over the list, and any other on its row", () => {
    expect(ownWhy(SHARED_WHY)).toBeNull();
    expect(ownWhy(null)).toBeNull();
    expect(ownWhy("This is hard to undo, so it needs your yes.")).toBe(
      "This is hard to undo, so it needs your yes.",
    );
  });
});
