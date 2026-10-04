// Events the kernel itself emits, on behalf of every module.
import type { EventDef } from "./types.ts";

export const KERNEL_EVENTS: EventDef[] = [
  { kind: "entity.created", description: "A record was created. Payload: type, title." },
  { kind: "entity.updated", description: "A record changed. Payload: type, changed field names." },
  { kind: "entity.deleted", description: "A record was moved to trash. Payload: type, title." },
  { kind: "entity.restored", description: "A record came back from trash." },
  {
    kind: "link.added",
    description: "A link appeared. Payload: fromId, toId, kind, anchor, toType.",
  },
  { kind: "link.removed", description: "A link went away. Payload: fromId, toId, kind, anchor." },
  {
    kind: "jarvis.mentioned",
    description:
      "Someone @mentioned Jarvis. Payload: anchor, context (the paragraph it sits in), type.",
  },
  {
    kind: "approval.requested",
    description:
      "An action is waiting for your yes. Payload: approvalId, action, summary, requestedBy.",
  },
  {
    kind: "approval.resolved",
    description:
      "You approved or denied something. Payload: approvalId, action, decision, requestedBy, result or error.",
  },
  {
    kind: "notification.created",
    description:
      "Something landed in the inbox. Payload: notificationId, kind, title, urgency, delivered, and retryAt for an interrupt held for quiet hours.",
  },
  {
    kind: "notification.updated",
    description:
      "An inbox item was seen, done or snoozed. Payload: notificationId, state, snoozedUntil.",
  },
  {
    kind: "clock.fired",
    description: "A schedule came due. Payload: scheduleId, kind, name, scheduledFor, stale.",
  },
];
