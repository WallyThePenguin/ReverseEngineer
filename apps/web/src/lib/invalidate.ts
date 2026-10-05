// Which cached reads a change can affect, so a live event or a change you made refreshes only
// those screens instead of every list at once.
//
// A cached read's key is [action name, input]. A rule lists action names, or whole modules as
// "mail." (every read whose name starts with it). No rule (null) means "refresh everything",
// which is what anything not listed here gets, so a new event kind is never left stale.

export type Rule = readonly string[];

const MAIL: Rule = ["mail.", "person.view", "company.view"];

/** By the event's module: the part of its kind before the first dot. */
const BY_MODULE: Record<string, Rule> = {
  // A channel Jarvis stopped answering in tells you with a card (D62).
  notification: ["inbox.list", "slack.channels"],
  approval: [
    "inbox.list",
    "approval.list",
    "conversation.",
    "standing_rule.list",
    // A held reply to someone in Slack shows on their conversation's bar (D62).
    "slack.conversation",
    "slack.conversations",
  ],
  link: ["entity.", "task.", "note.list", "person.view", "company.view", "doc."],
  mail: MAIL,
  task: ["task.", "inbox.list"],
  calendar: ["calendar.", "person.view", "company.view"],
  // A Slack member's conversation growing shows on the Slack screens too (D62).
  conversation: ["conversation.", "jarvis.activity", "slack.conversation", "slack.conversations"],
  chat: ["conversation.", "jarvis.activity"],
  jarvis: ["jarvis.", "observation.list", "system.status", "conversation."],
  system: ["system.status"],
  memory: ["memory."],
  page_watch: ["page_watch."],
  browser: ["browser.", "vault.logins"],
  vault: ["vault.", "browser.sites"],
  slack: ["slack."],
  github: ["github."],
  voice: ["dictation.", "dictionary.", "voice.", "snippet."],
  meeting: ["meeting."],
  // A schedule firing moves a routine's "last ran".
  clock: ["routine.list", "system.status"],
};

/** A record change can show anywhere it's linked or titled... */
const ANY_RECORD: Rule = ["entity.", "inbox.list", "person.view", "company.view", "doc."];

/** ...and in the lists of its own type. */
const BY_TYPE: Record<string, Rule> = {
  task: ["task."],
  // A Notion import is a note; Settings lists them.
  note: ["note.list", "notion.imports"],
  canvas: ["canvas."],
  spreadsheet: ["sheet."],
  person: ["person.", "company."],
  company: ["company.", "person."],
  meeting: ["meeting."],
  conversation: ["conversation."],
  comment: ["comment.list"],
  brief: [],
  journal: [],
  agent: [],
  prep: ["calendar."],
  page_watch: ["page_watch."],
  memory_note: ["memory."],
  event: ["calendar."],
  routine: ["routine.list"],
  email_thread: MAIL,
  email: MAIL,
  email_draft: ["mail.drafts"],
  snippet: ["snippet.list"],
  slack_message: ["slack."],
  github_pr: ["github."],
};

/** Reads a change made through an action can affect, beyond its own module's. */
const AFTER_CHANGE: Record<string, Rule> = {
  google: ["mail.", "calendar."],
  jarvis: ["system.status", "observation.list"],
  note: ["task.", "doc."],
  person: ["company.", "task."],
  company: ["person."],
  doc: ["note.list", "entity."],
  routine: ["system.status"],
  approval: ["inbox.list", "conversation."],
  standing_rule: ["approval.list"],
  // Jarvis's Slack bot holds the standing rule that lets its replies to members go out (D62).
  slack: ["standing_rule.list"],
};

const moduleOf = (name: string) => name.split(".", 1)[0] ?? "";

/** The reads a live event can change; null for all of them. */
export function affectedBy(e: { kind: string; payload?: Record<string, unknown> }): Rule | null {
  const module = moduleOf(e.kind);
  if (module === "entity") {
    const type = typeof e.payload?.type === "string" ? e.payload.type : null;
    const own = type === null ? undefined : BY_TYPE[type];
    return own ? [...ANY_RECORD, ...own] : null;
  }
  return BY_MODULE[module] ?? null;
}

/** The reads a change you made through `action` can affect; null for all of them. */
export function affectedByChange(action: string): Rule | null {
  const module = moduleOf(action);
  // Trashing a record (any type) shows in that type's lists, which the name doesn't tell.
  if (module === "entity") return null;
  return [`${module}.`, ...(AFTER_CHANGE[module] ?? [])];
}

/** Whether a cached read with this key falls under the rule. */
export function touches(rule: Rule, queryKey: readonly unknown[]): boolean {
  const name = queryKey[0];
  if (typeof name !== "string") return true;
  return rule.some((r) => (r.endsWith(".") ? name.startsWith(r) : name === r));
}

/** Joins rules; any "everything" makes the whole thing everything. */
export function union(rules: (Rule | null)[]): Rule | null {
  const out = new Set<string>();
  for (const r of rules) {
    if (r === null) return null;
    for (const x of r) out.add(x);
  }
  return [...out];
}
