// One click in Mail: archive, make a task, and reply with the cursor ready, from a conversation's
// row or from the conversation itself. Archiving a conversation opened from the list moves on to
// the next one in it, as Gmail does; one opened from anywhere else (a task's link, Ctrl+K) closes.

import { renderMention } from "@hearth/core";
import { createSignal } from "solid-js";
import { toast } from "./live.ts";
import { layout, routeFor } from "./panes.ts";
import { act } from "./query.ts";
import type { MailAddress, MailDraft, MailThread, Task } from "./types.ts";

type Row = Pick<MailThread, "id" | "unread">;

/** The conversation to show once `id` leaves: the next one down, or the one above at the end. */
export function nextAfter(rows: readonly Row[], id: string): Row | undefined {
  const at = rows.findIndex((r) => r.id === id);
  if (at < 0) return undefined;
  return rows[at + 1] ?? rows[at - 1];
}

let order: (() => readonly Row[]) | null = null;
/** The conversation the list last opened: only that one moves on through it. */
let fromList: string | null = null;

/** The list just opened conversation `id`: archiving it moves on through this list. */
export function openedFrom(list: () => readonly Row[], id: string) {
  order = list;
  fromList = id;
}

/** That list closed: archiving a conversation from it closes the conversation instead. */
export function listClosed(list: () => readonly Row[]) {
  if (order !== list) return;
  order = null;
  fromList = null;
}

/** The conversation after `id` in the list it was opened from, if it was opened from one. */
export const nextInList = (id: string) =>
  order && fromList === id ? nextAfter(order(), id) : undefined;

/** Shows a conversation in pane `pane`, read, as opening it from the list does. */
export function showThread(t: Row, pane: number) {
  if (t.unread) void act("mail.mark_read", { ids: [t.id] });
  // Moving on through the list: the next one came from it too.
  if (order) fromList = t.id;
  layout.open({ view: "thread", id: t.id }, { pane });
}

/**
 * Archives a conversation, with Undo on the toast: one click on a row is easy to make by mistake.
 * Undo puts back in the inbox exactly the messages archiving took out, and nothing else (not a
 * reply you sent, not one deleted in Gmail since).
 */
export async function archive(id: string) {
  const done = await act<{ changed: number; inbox: string[] }>("mail.archive", { ids: [id] });
  if (!done) return false;
  toast.show("Archived.", "info", {
    label: "Undo",
    run: () => void act("mail.unarchive", { ids: [id], messages: done.inbox }),
  });
  return true;
}

/**
 * What a task made from an email is called, and the line that links it back to the email. The
 * link is a mention, so the email lists the task under what links to it, and the task opens it.
 */
export function taskFrom(t: { id: string; subject: string; from?: MailAddress }) {
  const subject = t.subject.trim();
  const sender = t.from?.name || t.from?.address;
  const title = subject || (sender ? `Email from ${sender}` : "An email");
  return {
    title: title.slice(0, 500),
    body: `From ${renderMention({ type: "email_thread", id: t.id, label: subject || title })}`,
  };
}

/**
 * Makes a task from a conversation; the toast opens it beside. Its title is the sender's words, so
 * the task is outside content: Jarvis reading it later never takes them as yours (D58).
 */
export async function makeTask(t: Pick<MailThread, "id" | "subject" | "account" | "participants">) {
  const from = t.participants.find((p) => p.address !== t.account);
  const made = await act<Task>("task.create", {
    ...taskFrom({ id: t.id, subject: t.subject, from }),
    outside: true,
  });
  if (!made) return;
  toast.show(`Task made: ${made.title}`, "info", {
    label: "Open",
    run: () => layout.open(routeFor("task", made.id), { beside: true }),
  });
}

const [draftForCursor, setCursorFor] = createSignal<string | null>(null);
/** The draft the cursor goes into once it's drawn: a reply just started, or one already waiting. */
export const cursorFor = draftForCursor;
/** The draft has the cursor now. */
export const cursorPlaced = () => setCursorFor(null);

/**
 * Replies to a conversation with the cursor in the message. A reply already waiting (one Jarvis
 * drafted, or yours from before) gets the cursor instead of a second draft being started.
 */
export async function reply(threadId: string, drafts: readonly MailDraft[], all = false) {
  const waiting = all ? undefined : drafts.find((d) => d.threadId === threadId);
  if (waiting) return void setCursorFor(waiting.id);
  const d = await act<MailDraft>("mail.draft", { threadId, replyAll: all, text: "" });
  if (d) setCursorFor(d.id);
}
