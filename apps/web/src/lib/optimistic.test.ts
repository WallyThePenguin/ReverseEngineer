import { QueryClient } from "@tanstack/solid-query";
import { beforeEach, describe, expect, it } from "vitest";
import { applyOptimistic } from "./optimistic.ts";
import type { InboxRow, MailThread } from "./types.ts";

const row = (id: string, state: "unseen" | "seen" = "unseen") =>
  ({
    notification: { id, state, title: id },
    entityTitle: null,
    entityType: null,
    approvalStatus: null,
  }) as unknown as InboxRow;

const thread = (id: string, extra: Partial<MailThread> = {}) =>
  ({ id, unread: true, starred: false, inInbox: true, trashed: false, ...extra }) as MailThread;

const LIVE = ["inbox.list", { view: "live", lane: "signal", limit: 100 }];
const DONE = ["inbox.list", { view: "done", limit: 100 }];
const INBOX = ["mail.threads", { view: "inbox", lane: "signal", limit: 100 }];
const STARRED = ["mail.threads", { view: "starred", limit: 100 }];

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient();
});
const ids = (k: unknown[]) =>
  (client.getQueryData(k) as { id?: string; notification?: { id: string } }[]).map(
    (x) => x.id ?? x.notification?.id,
  );

describe("changes that show at once", () => {
  it("takes a done item out of the inbox, and puts it back if the server says no", () => {
    client.setQueryData(LIVE, [row("a"), row("b")]);
    client.setQueryData(DONE, [row("z", "seen")]);
    const undo = applyOptimistic(client, "inbox.mark", { ids: ["a"], state: "done" });
    expect(ids(LIVE)).toEqual(["b"]);
    // It isn't added to the done list: that list doesn't have the row to show.
    expect(ids(DONE)).toEqual(["z"]);
    undo!();
    expect(ids(LIVE)).toEqual(["a", "b"]);
  });

  it("marks an item seen in place, and snoozing hides it from the live list", () => {
    client.setQueryData(LIVE, [row("a"), row("b")]);
    applyOptimistic(client, "inbox.mark", { ids: ["b"], state: "seen" });
    const rows = client.getQueryData(LIVE) as InboxRow[];
    expect(rows.map((r) => r.notification.state)).toEqual(["unseen", "seen"]);
    applyOptimistic(client, "inbox.snooze", { id: "a", until: "2026-10-05T09:00:00Z" });
    expect(ids(LIVE)).toEqual(["b"]);
  });

  it("archives out of the mail inbox but keeps it, unboxed, elsewhere", () => {
    client.setQueryData(INBOX, [thread("t1"), thread("t2")]);
    client.setQueryData(STARRED, [thread("t1", { starred: true })]);
    client.setQueryData(["mail.thread", { id: "t1" }], thread("t1", { messages: [] } as never));
    const undo = applyOptimistic(client, "mail.archive", { ids: ["t1"] });
    expect(ids(INBOX)).toEqual(["t2"]);
    expect((client.getQueryData(STARRED) as MailThread[])[0]?.inInbox).toBe(false);
    expect((client.getQueryData(["mail.thread", { id: "t1" }]) as MailThread).inInbox).toBe(false);
    undo!();
    expect(ids(INBOX)).toEqual(["t1", "t2"]);
    expect((client.getQueryData(["mail.thread", { id: "t1" }]) as MailThread).inInbox).toBe(true);
  });

  it("stars, unstars out of the starred list, and marks read or unread", () => {
    client.setQueryData(INBOX, [thread("t1"), thread("t2")]);
    client.setQueryData(STARRED, [thread("t1", { starred: true })]);
    applyOptimistic(client, "mail.star", { ids: ["t2"] });
    expect((client.getQueryData(INBOX) as MailThread[]).map((t) => t.starred)).toEqual([
      false,
      true,
    ]);
    applyOptimistic(client, "mail.star", { ids: ["t1"], starred: false });
    expect(ids(STARRED)).toEqual([]);
    applyOptimistic(client, "mail.mark_read", { ids: ["t1"] });
    applyOptimistic(client, "mail.mark_read", { ids: ["t2"], read: false });
    expect((client.getQueryData(INBOX) as MailThread[]).map((t) => t.unread)).toEqual([
      false,
      true,
    ]);
  });

  it("edits every page of a list read a page at a time, and puts them all back", () => {
    const PAGED = ["mail.threads", { view: "inbox", lane: "signal", limit: 50 }];
    const pages = { pages: [[thread("t1"), thread("t2")], [thread("t3")]], pageParams: [{}, {}] };
    client.setQueryData(PAGED, pages);
    const undo = applyOptimistic(client, "mail.archive", { ids: ["t3", "t1"] });
    const now = client.getQueryData(PAGED) as { pages: MailThread[][]; pageParams: unknown[] };
    expect(now.pages.map((p) => p.map((t) => t.id))).toEqual([["t2"], []]);
    expect(now.pageParams).toEqual([{}, {}]);
    applyOptimistic(client, "mail.mark_read", { ids: ["t2"] });
    expect((client.getQueryData(PAGED) as typeof now).pages[0]?.[0]?.unread).toBe(false);
    undo!();
    expect(client.getQueryData(PAGED)).toEqual(pages);
  });

  it("leaves reads it doesn't know alone, and has nothing to undo for other actions", () => {
    client.setQueryData(["task.list", {}], [{ id: "t1" }]);
    expect(applyOptimistic(client, "task.update", { id: "t1", title: "x" })).toBeNull();
    applyOptimistic(client, "mail.archive", { ids: ["t1"] });
    expect(client.getQueryData(["task.list", {}])).toEqual([{ id: "t1" }]);
  });
});
