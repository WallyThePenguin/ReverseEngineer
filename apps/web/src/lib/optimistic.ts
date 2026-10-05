// Changes that show at once: the lists on screen are edited the way the server is about to edit
// them, before it answers. If the server says no, they're put back exactly as they were.

import type { QueryClient, QueryKey } from "@tanstack/solid-query";
import type { InboxRow, MailThread } from "./types.ts";

/** How one change edits one kind of cached read. */
interface Patch {
  read: string;
  edit(data: unknown, input: Record<string, unknown>): unknown;
}

const ids = (input: unknown): Set<string> => {
  const i = input as { ids?: unknown; id?: unknown };
  const list = Array.isArray(i.ids) ? i.ids : typeof i.id === "string" ? [i.id] : [];
  return new Set(list.filter((x): x is string => typeof x === "string"));
};

const inputOf = (key: QueryKey): Record<string, unknown> =>
  (key[1] && typeof key[1] === "object" ? key[1] : {}) as Record<string, unknown>;

/** Edits the inbox rows a change touches. `gone` drops them from this list instead. */
function inboxRows(
  change: Record<string, unknown>,
  how: (view: string) => "gone" | Partial<InboxRow["notification"]> | null,
): Patch {
  return {
    read: "inbox.list",
    edit(data, input) {
      const which = ids(change);
      const what = how(String(input.view ?? "live"));
      if (what === null || !Array.isArray(data)) return data;
      const rows = data as InboxRow[];
      if (what === "gone") return rows.filter((r) => !which.has(r.notification.id));
      return rows.map((r) =>
        which.has(r.notification.id) ? { ...r, notification: { ...r.notification, ...what } } : r,
      );
    },
  };
}

/** Edits the conversations a change touches, in lists, search results and an open thread. */
function mailThreads(
  change: Record<string, unknown>,
  how: (list: Record<string, unknown>) => "gone" | Partial<MailThread> | null,
): Patch[] {
  const edit = (data: unknown, input: Record<string, unknown>): unknown => {
    // A list read a page at a time: each page is edited the same way.
    const paged = data as { pages?: unknown } | undefined;
    if (paged && Array.isArray(paged.pages))
      return { ...paged, pages: paged.pages.map((page) => edit(page, input)) };
    const which = ids(change);
    const what = how(input);
    if (what === null || !Array.isArray(data)) return data;
    const rows = data as MailThread[];
    if (what === "gone") return rows.filter((t) => !which.has(t.id));
    return rows.map((t) => (which.has(t.id) ? { ...t, ...what } : t));
  };
  return [
    { read: "mail.threads", edit },
    { read: "mail.search", edit: (data) => edit(data, { view: "search" }) },
    {
      read: "mail.thread",
      edit(data) {
        const t = data as MailThread | undefined;
        const what = how({ view: "thread" });
        if (!t || !ids(change).has(t.id) || what === null || what === "gone") return data;
        return { ...t, ...what };
      },
    },
  ];
}

/** Lists of records you can move to the trash. */
const RECORD_LISTS = [
  "task.list",
  "note.list",
  "canvas.list",
  "sheet.list",
  "person.list",
  "memory.list",
  "conversation.list",
  "comment.list",
  "page_watch.list",
  "snippet.list",
  "entity.recent",
];

/** The edits a change makes to cached reads, by action name. */
export function patchesFor(action: string, change: Record<string, unknown>): Patch[] {
  switch (action) {
    case "entity.trash":
      // A record moved to the trash leaves every list it's in.
      return RECORD_LISTS.map((read) => ({
        read,
        edit(data) {
          if (!Array.isArray(data)) return data;
          const which = ids(change);
          return data.filter((r) => !which.has((r as { id?: string }).id ?? ""));
        },
      }));
    case "inbox.mark": {
      const state = change.state as "unseen" | "seen" | "done";
      return [
        inboxRows(change, (view) => {
          // Done items leave the live and snoozed lists; anything else leaves the done list.
          if (state === "done") return view === "done" ? null : "gone";
          return view === "done" ? "gone" : { state };
        }),
      ];
    }
    case "inbox.snooze":
      return [inboxRows(change, (view) => (view === "live" ? "gone" : null))];
    case "mail.mark_read": {
      const unread = change.read === false;
      return mailThreads(change, () => ({ unread }));
    }
    case "mail.archive":
      return mailThreads(change, (list) => (list.view === "inbox" ? "gone" : { inInbox: false }));
    case "mail.unarchive":
      return mailThreads(change, (list) =>
        list.view === "trash" ? "gone" : { inInbox: true, trashed: false },
      );
    case "mail.star": {
      const starred = change.starred !== false;
      return mailThreads(change, (list) =>
        list.view === "starred" && !starred ? "gone" : { starred },
      );
    }
    default:
      return [];
  }
}

/**
 * Applies a change to the cached reads it touches. Returns how to put them back, or null when
 * the change has no instant version.
 */
export function applyOptimistic(
  client: QueryClient,
  action: string,
  change: unknown,
): (() => void) | null {
  const input = (change && typeof change === "object" ? change : {}) as Record<string, unknown>;
  const patches = patchesFor(action, input);
  if (patches.length === 0) return null;
  const before: [QueryKey, unknown][] = [];
  for (const q of client.getQueryCache().getAll()) {
    const patch = patches.find((p) => p.read === q.queryKey[0]);
    if (!patch || q.state.data === undefined) continue;
    // A read already on its way would land on top of the change and undo it for a moment.
    void client.cancelQueries({ queryKey: q.queryKey, exact: true });
    const data = client.getQueryData(q.queryKey);
    before.push([q.queryKey, data]);
    client.setQueryData(q.queryKey, patch.edit(data, inputOf(q.queryKey)));
  }
  return () => {
    for (const [key, data] of before) client.setQueryData(key, data);
    // Anything else that landed meanwhile is worth reading again.
    for (const [key] of before) void client.invalidateQueries({ queryKey: key, exact: true });
  };
}
