// What Jarvis used, said as a sentence: "Drafted an email" in place of mail.draft. Each action
// Jarvis reaches for often has its words here, as it's under way and once it's done; any other
// says its own name in plain words. The raw input stays one click away, under the line.

type Said = readonly [doing: string, done: string];

const SAID: Record<string, Said> = {
  "mail.draft": ["Drafting an email", "Drafted an email"],
  "mail.draft_update": ["Changing a draft", "Changed a draft"],
  "mail.send": ["Sending an email", "Sent an email"],
  "mail.discard": ["Throwing away a draft", "Threw away a draft"],
  "mail.search": ["Searching your mail", "Searched your mail"],
  "mail.thread": ["Reading an email", "Read an email"],
  "mail.threads": ["Looking through your mail", "Looked through your mail"],
  "mail.archive": ["Archiving mail", "Archived mail"],
  "mail.star": ["Starring mail", "Starred mail"],
  "mail.no_reply": ["Marking mail as needing no reply", "Marked mail as needing no reply"],
  "mail.set_lane": ["Sorting a sender's mail", "Sorted a sender's mail"],
  "calendar.events": ["Checking your calendar", "Checked your calendar"],
  "calendar.get": ["Looking at an event", "Looked at an event"],
  "calendar.free_time": ["Finding free time", "Found free time"],
  "calendar.conflicts": ["Checking for clashes", "Checked for clashes"],
  "calendar.create_event": ["Adding an event", "Added an event"],
  "calendar.update_event": ["Changing an event", "Changed an event"],
  "calendar.delete_event": ["Removing an event", "Removed an event"],
  "calendar.schedule_meeting": ["Inviting people to a meeting", "Invited people to a meeting"],
  "calendar.update_meeting": ["Changing a meeting", "Changed a meeting"],
  "calendar.cancel_meeting": ["Cancelling a meeting", "Cancelled a meeting"],
  "calendar.respond": ["Answering an invitation", "Answered an invitation"],
  "calendar.block_task": ["Blocking time for a task", "Blocked time for a task"],
  "task.create": ["Making a task", "Made a task"],
  "task.update": ["Updating a task", "Updated a task"],
  "task.get": ["Reading a task", "Read a task"],
  "task.list": ["Looking through your tasks", "Looked through your tasks"],
  "note.create": ["Writing a note", "Wrote a note"],
  "note.edit": ["Editing a note", "Edited a note"],
  "note.update": ["Editing a note", "Edited a note"],
  "note.list": ["Looking through your notes", "Looked through your notes"],
  "person.create": ["Adding a person", "Added a person"],
  "person.update": ["Updating a person", "Updated a person"],
  "person.view": ["Looking someone up", "Looked someone up"],
  "person.list": ["Looking through your people", "Looked through your people"],
  "memory.remember": ["Remembering something", "Remembered something"],
  "memory.recall": ["Checking what it remembers", "Checked what it remembers"],
  "memory.update": ["Updating what it remembers", "Updated what it remembers"],
  "entity.search": ["Searching Hearth", "Searched Hearth"],
  "entity.get": ["Reading a record", "Read a record"],
  "record.read": ["Reading a record", "Read a record"],
  "entity.trash": ["Moving something to the trash", "Moved something to the trash"],
  "comment.create": ["Writing a comment", "Wrote a comment"],
  "inbox.notify": ["Adding to your inbox", "Added to your inbox"],
  "reminder.create": ["Setting a reminder", "Set a reminder"],
  "browser.open": ["Opening a page in Chrome", "Opened a page in Chrome"],
  "browser.navigate": ["Going to a page in Chrome", "Went to a page in Chrome"],
  "browser.read": ["Reading a page", "Read a page"],
  "browser.read_page": ["Reading a page", "Read a page"],
  "browser.get_text": ["Reading a page", "Read a page"],
  "browser.find": ["Looking for something on a page", "Looked for something on a page"],
  "browser.screenshot": ["Looking at a page", "Looked at a page"],
  "browser.click": ["Clicking on a page", "Clicked on a page"],
  "browser.type": ["Typing on a page", "Typed on a page"],
  "browser.form_input": ["Filling in a form", "Filled in a form"],
  "browser.submit": ["Sending a form", "Sent a form"],
  "browser.scroll": ["Scrolling a page", "Scrolled a page"],
  "browser.tabs": ["Checking Chrome's tabs", "Checked Chrome's tabs"],
  "page_watch.create": ["Setting up a page watch", "Set up a page watch"],
  "jarvis.watch": ["Setting up a watch", "Set up a watch"],
  "routine.create": ["Making a routine", "Made a routine"],
  "slack.messages": ["Reading Slack", "Read Slack"],
  "github.prs": ["Checking pull requests", "Checked pull requests"],
  "data.documents": ["Reading a table", "Read a table"],
  "data.query": ["Looking something up in your data", "Looked something up in your data"],
  "data.change": ["Changing your data", "Changed your data"],
  "sheet.set": ["Editing a sheet", "Edited a sheet"],
  "meeting.get": ["Reading meeting notes", "Read meeting notes"],
};

/** A tool's action as Hearth names it: older conversations logged `mcp__hearth__mail_draft`. */
function actionOf(name: string): string {
  const bare = name.replace(/^mcp__hearth__/, "");
  return bare.includes(".") ? bare : bare.replace("_", ".");
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** What a tool does, as it's under way, without the dots: "Sending an email". */
export function toolDoing(name: string): string {
  const action = actionOf(name);
  return SAID[action]?.[0] ?? `Using ${action.replace(/[._]/g, " ")}`;
}

/**
 * The line for a tool Jarvis used: "Drafting an email…" while it runs, "Drafted an email" once
 * done, "Asked before sending an email" while it waits for your yes, and "Sending an email
 * failed". One without words of its own says its name: "Used mail draft update".
 */
export function toolSentence(
  name: string,
  status: "running" | "done" | "pending_approval",
  failed = false,
): string {
  const action = actionOf(name);
  const words = action.replace(/[._]/g, " ");
  const [doing, done] = SAID[action] ?? [`Using ${words}`, `Used ${words}`];
  if (failed) return `${doing} failed`;
  if (status === "running") return `${doing}…`;
  if (status === "pending_approval") return `Asked before ${lowerFirst(doing)}`;
  return done;
}
