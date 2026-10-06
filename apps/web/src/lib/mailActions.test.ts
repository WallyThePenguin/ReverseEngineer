// One click in Mail: archiving moves on to the right conversation, a task made from an email
// links back to it, and Reply puts the cursor in the reply already waiting instead of starting
// a second one.
import { parseMentions } from "@hearth/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Solid's browser build: the server build tests run with by default isn't reactive.
// @ts-expect-error: the browser build has no types of its own; they're the package's.
vi.mock("solid-js", () => import("solid-js/dist/solid.js"));

const calls: { name: string; input: Record<string, unknown> }[] = [];
const toasts: { text: string; action?: { label: string; run: () => void } }[] = [];
vi.mock("./query.ts", () => ({
  act: async (name: string, input: Record<string, unknown>) => {
    calls.push({ name, input });
    if (name === "mail.draft") return { id: "new-draft", threadId: input.threadId };
    if (name === "task.create") return { id: "task-1", title: input.title };
    if (name === "mail.archive") return { changed: 1, inbox: ["m1", "m3"] };
    return {};
  },
}));
vi.mock("./live.ts", () => ({
  toast: {
    show: (text: string, _tone: string, action?: { label: string; run: () => void }) =>
      toasts.push({ text, action }),
  },
}));
vi.mock("./panes.ts", () => ({
  layout: { open: vi.fn() },
  routeFor: (type: string, id: string) => ({ view: type, id }),
}));

const {
  archive,
  cursorFor,
  cursorPlaced,
  listClosed,
  makeTask,
  nextAfter,
  nextInList,
  openedFrom,
  reply,
  showThread,
  taskFrom,
} = await import("./mailActions.ts");

const THREAD = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const rows = (...ids: string[]) => ids.map((id) => ({ id, unread: false }));

beforeEach(() => {
  calls.length = 0;
  toasts.length = 0;
  cursorPlaced();
});

describe("archiving moves on", () => {
  it("to the next conversation down, or the one above at the end", () => {
    expect(nextAfter(rows("a", "b", "c"), "b")?.id).toBe("c");
    expect(nextAfter(rows("a", "b", "c"), "c")?.id).toBe("b");
    expect(nextAfter(rows("a"), "a")).toBeUndefined();
  });

  it("nowhere when the conversation isn't in the list it came from", () => {
    expect(nextAfter(rows("a", "b"), "z")).toBeUndefined();
  });

  it("through the list it was opened from, until that list closes", () => {
    const list = () => rows("a", "b");
    openedFrom(list, "a");
    expect(nextInList("a")?.id).toBe("b");
    // Another list closing leaves this one in place.
    listClosed(() => rows("x"));
    expect(nextInList("a")?.id).toBe("b");
    listClosed(list);
    expect(nextInList("a")).toBeUndefined();
  });

  it("and on again, from each conversation it moved on to", () => {
    const list = () => rows("a", "b", "c");
    openedFrom(list, "a");
    showThread(rows("b")[0]!, 0);
    expect(nextInList("b")?.id).toBe("c");
    listClosed(list);
  });

  it("not from a conversation opened somewhere else while the list stays open", () => {
    const list = () => rows("a", "b", "c");
    openedFrom(list, "a");
    // "b" opened from a task's link or Ctrl+K: archiving it closes it instead.
    expect(nextInList("b")).toBeUndefined();
    listClosed(list);
  });

  it("with Undo on the toast, which puts back just the messages it took out", async () => {
    expect(await archive("a")).toBe(true);
    expect(calls).toEqual([{ name: "mail.archive", input: { ids: ["a"] } }]);
    expect(toasts[0]?.action?.label).toBe("Undo");
    toasts[0]?.action?.run();
    expect(calls.at(-1)).toEqual({
      name: "mail.unarchive",
      input: { ids: ["a"], messages: ["m1", "m3"] },
    });
  });
});

describe("a task from an email", () => {
  it("is named after the subject and links back to the conversation", () => {
    const t = taskFrom({ id: THREAD, subject: "  Lease renewal  " });
    expect(t.title).toBe("Lease renewal");
    expect(parseMentions(t.body)).toMatchObject([
      { type: "email_thread", id: THREAD, label: "Lease renewal" },
    ]);
  });

  it("is named after the sender when there's no subject", () => {
    const from = { name: "Sam Lee", address: "sam@example.com" };
    expect(taskFrom({ id: THREAD, subject: "", from }).title).toBe("Email from Sam Lee");
    expect(taskFrom({ id: THREAD, subject: " " }).title).toBe("An email");
  });

  it("is marked as outside text, since the sender wrote its title", async () => {
    await makeTask({ id: THREAD, subject: "Pay now", account: "me@x.example", participants: [] });
    expect(calls[0]).toMatchObject({ name: "task.create", input: { outside: true } });
  });

  it("keeps a subject with markup in it as text", () => {
    const t = taskFrom({ id: THREAD, subject: "<b>Q3</b> & you" });
    expect(parseMentions(t.body)).toMatchObject([{ id: THREAD, label: "<b>Q3</b> & you" }]);
  });
});

describe("reply", () => {
  const draft = (id: string, threadId: string | null) =>
    ({ id, threadId, by: "jarvis" }) as Parameters<typeof reply>[1][number];

  it("puts the cursor in the reply already waiting, without starting another", async () => {
    await reply("t1", [draft("other", "t2"), draft("jarvis-draft", "t1")]);
    expect(calls).toEqual([]);
    expect(cursorFor()).toBe("jarvis-draft");
  });

  it("starts a reply when none is waiting, and puts the cursor in it", async () => {
    await reply("t1", [draft("fresh", null)]);
    expect(calls).toEqual([
      { name: "mail.draft", input: { threadId: "t1", replyAll: false, text: "" } },
    ]);
    expect(cursorFor()).toBe("new-draft");
  });

  it("always starts a new reply to everyone", async () => {
    await reply("t1", [draft("mine", "t1")], true);
    expect(calls[0]?.input).toMatchObject({ threadId: "t1", replyAll: true });
    expect(cursorFor()).toBe("new-draft");
  });
});
