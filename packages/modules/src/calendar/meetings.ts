// Meetings with guests: inviting, changing and cancelling, each waiting for your yes (PLAN.md
// section 5.5). The approval names the meeting as the calendar has it and, after a blank line, says
// what the guests get besides the time (where, and the description, word for word), so its row
// opens to them before Approve and a yes never covers words you haven't seen (D33). A request
// made before Hearth showed that has no snapshot: it isn't run, and Jarvis is to ask again.
import { type ActionContext, ActionError, defineAction, type ReadContext } from "@hearth/kernel";
import { z } from "zod";
import { id } from "../shared.ts";
import {
  describeTimes,
  emails,
  fields,
  insertEvent,
  meetingText,
  patchEvent,
  plainTitle,
  removeEvent,
  when,
} from "./actions.ts";
import { loadEvent } from "./store.ts";

const ASK_AGAIN =
  "This was asked before Hearth showed which meeting it is and what its guests get, so it wasn't done. Ask for it again.";
const CHANGED = "The meeting changed since you were asked, so it wasn't done.";

const filledIn = "Filled in by Hearth. Leave it out.";
const theMeeting = z.object({ event: z.string() }).optional().describe(filledIn);

/** What guests of a new meeting get besides the time: where, and the description. */
export function invitedTo(i: { location?: string; description?: string }): string | null {
  const parts = [
    i.location?.trim() ? `Where: ${i.location.trim()}` : null,
    i.description?.trim() || null,
  ].filter((p) => p !== null);
  return parts.length ? parts.join("\n\n") : null;
}

/** What guests are told changed besides the time: the new place and description, or that they went. */
export function changedFor(i: { location?: string; description?: string }): string | null {
  const parts = [
    i.location === undefined ? null : `Where: ${i.location.trim() || "(none)"}`,
    i.description === undefined ? null : i.description.trim() || "Description: (none)",
  ].filter((p) => p !== null);
  return parts.length ? parts.join("\n\n") : null;
}

/** The line, then what guests get after a blank line: the row opens to it before a yes. */
const withDetails = (line: string, details: string | null) =>
  details ? `${line}\n\n${details}` : line;

/** Names the meeting as the calendar has it now, for the approval and the check when it runs. */
async function nameMeeting(i: { id: string }, ctx: ReadContext) {
  const ev = await loadEvent(ctx.db, i.id);
  if (!ev) throw new Error("No event with that id.");
  return { snapshot: { event: await meetingText(ctx.db, ev) } };
}

/**
 * Runs only what you were shown: the meeting as it was when you were asked. Your own call needs no
 * snapshot; anyone else's without one was asked before Hearth showed the meeting.
 */
async function asShown(ctx: ActionContext, eventId: string, shown: string | undefined) {
  if (shown === undefined) {
    if (ctx.caller.kind === "owner") return;
    throw new ActionError("conflict", ASK_AGAIN);
  }
  const ev = await loadEvent(ctx.tx, eventId);
  if (!ev) throw new ActionError("not_found", "Event not found");
  if (shown !== (await meetingText(ctx.tx, ev))) throw new ActionError("conflict", CHANGED);
}

export const meetingActions = [
  defineAction({
    name: "calendar.schedule_meeting",
    description: "Create a meeting and send invitations to guests by email.",
    input: z.object({
      ...fields,
      attendees: emails,
      calendarId: z.string().optional(),
      snapshot: z.object({ guestsGet: z.string() }).optional().describe(filledIn),
    }),
    risk: "outward",
    async snapshot(i) {
      return { snapshot: { guestsGet: invitedTo(i) ?? "" } };
    },
    summarize: (i) =>
      withDetails(`Invite ${i.attendees.join(", ")} to ${describeTimes(i)}`, invitedTo(i)),
    handler({ snapshot, ...i }, ctx) {
      if (snapshot ? snapshot.guestsGet !== (invitedTo(i) ?? "") : ctx.caller.kind !== "owner")
        throw new ActionError("conflict", ASK_AGAIN);
      return insertEvent(ctx, i);
    },
  }),
  defineAction({
    name: "calendar.update_meeting",
    description: "Change a meeting the owner organizes; guests get an update.",
    input: z.object({
      id,
      title: fields.title.optional(),
      start: when.optional(),
      end: when.optional(),
      description: fields.description,
      location: fields.location,
      snapshot: theMeeting,
    }),
    risk: "outward",
    snapshot: nameMeeting,
    summarize(i) {
      const changes = [
        i.title === undefined ? null : `call it ${plainTitle(i.title)}`,
        i.start || i.end ? `move it to ${i.start ?? "its start"} to ${i.end ?? "its end"}` : null,
        i.location === undefined ? null : "change where",
        i.description === undefined ? null : "change its description",
      ].filter((c) => c !== null);
      const what = `Change ${i.snapshot?.event ?? "a meeting"}${changes.length ? `: ${changes.join(", ")}` : ""}, telling its guests`;
      return withDetails(what, changedFor(i));
    },
    async handler({ id: eid, snapshot, ...patch }, ctx) {
      await asShown(ctx, eid, snapshot?.event);
      return patchEvent(ctx, eid, patch, true);
    },
  }),
  defineAction({
    name: "calendar.cancel_meeting",
    description: "Cancel a meeting the owner organizes; guests are told.",
    input: z.object({ id, snapshot: theMeeting }),
    risk: "outward",
    snapshot: nameMeeting,
    summarize: (i) => `Cancel ${i.snapshot?.event ?? "a meeting"} and tell its guests`,
    async handler(i, ctx) {
      await asShown(ctx, i.id, i.snapshot?.event);
      return removeEvent(ctx, i.id, true);
    },
  }),
];
