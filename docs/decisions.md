# Decisions

Each entry records a choice, what else was considered, and why. Newest at the bottom. Change a
decision by adding a new entry that supersedes the old one, so the history stays readable.

## D1. Build for one person on one PC (2026-10-01)

**Decision:** The workspace serves exactly one user (you) and runs on your always-on Windows PC,
reached over Tailscale.

**Why:** Your answer: "Just me." This removes teams, sharing permissions, tenancy, billing and
hosted infrastructure, which make up much of Macro's size. The PC already runs Jarvis and has the
hardware for local speech models (Ryzen 7 9700X, 61 GB RAM, RTX 2060 SUPER).

## D2. Lean rebuild instead of forking Macro (2026-10-01)

**Decision:** Write a new, small codebase. Borrow Macro's ideas and selected packages.

**Alternatives:**
- *Fork Macro and strip it.* Rejected. Macro is about 1.1M lines of Rust and 1.3M of TypeScript
  across ~50 services and 221 crates, built for AWS (Lambda, SQS, SNS, S3, SES), Kafka,
  OpenSearch, FusionAuth, Doppler, Datadog and Cloudflare Durable Objects, with multi-tenant
  permissions throughout and Gmail-only email. Its team merges dozens of PRs a day. Stripping it
  down to one user on one PC means rewriting the infrastructure layer of nearly every service,
  and the fork would drift away from upstream immediately.
- *Twenty as the backbone.* Rejected; see D3.
- *Grow the existing Jarvis into the workspace.* Rejected. It has no data model (about a dozen
  loose state files), several 2,000-line modules, and you've judged its core flawed.

**Why:** A focused codebase one person can understand and change, built for D1 from the start.

## D3. Don't run Twenty; borrow from it (2026-10-01)

**Decision:** Twenty is a design and code reference, not a dependency.

**Why:** Twenty is a strong CRM, but as the workspace backbone it lacks:
- bidirectional links (its mentions are display-only)
- an email inbox (it is sync-to-timeline only, drops attachments and filters newsletters)
- room for custom docs, canvas or chat UI (front components are beta, with a partial DOM)

Running it only as the CRM would mean two systems of record for the same people and a 2–3 GB
stack for a small part of the product. Its MIT packages, AGPL sync drivers and design patterns
are borrowed instead. See [research/twenty.md](research/twenty.md).

## D4. Rebuild Jarvis as the workspace's native agent (2026-10-01)

**Decision:** Jarvis is rewritten as part of the workspace. Its memory, briefs, prep and watches
become workspace records; its tools are the workspace's own actions. The old code is a reference
only.

**Why:** You want Jarvis "heavily integrated" and "up to standard", you aren't using the current
version, and you've cleared a full overhaul. Keeping the old Jarvis alive in parallel would mean
maintaining two data stores and two permission systems.

## D5. Keep the Claude Max subscription, no API key (2026-10-01)

**Decision:** The agent runs on the Claude Agent SDK, logged in through your `claude` CLI, as
Jarvis does today.

**Notes:** Anthropic's Agent SDK docs say third-party developers may not offer claude.ai login or
rate limits in their products without approval. A personal tool on your own login is not that
case, but the workspace must stay personal while it uses this login. The agent's credentials sit
behind one config value so it can switch to an API key.

## D6. TypeScript plus Rust, no Python (2026-10-01)

**Decision:** TypeScript for the server, worker, agent and web UI; Rust for the desktop app and
voice service.

**Alternatives:** Python for the agent (as Jarvis is today); Rust for the server (as Macro is).

**Why:** One language for everything you'll touch most, shared types between the UI, the API and
the agent tools, and the Agent SDK has a TypeScript version. Rust is only where native audio,
hotkeys and speech models need it, and Handy already provides that code.

## D7. PostgreSQL as the only store (2026-10-01)

**Decision:** PostgreSQL 17 with pgvector holds records, links, full-text search, embeddings, the
event log and the job queue (pg-boss at first; see D23).

**Alternatives:** SQLite (simplest single file, but weaker for concurrent workers and
vector search); Postgres plus Redis plus OpenSearch (Macro's shape, which is too much for one user).

**Why:** One service to install, back up and reason about, with enough headroom never to need
a second one.

## D8. Run natively on Windows, no containers (2026-10-01)

**Decision:** Each process is a Windows service with automatic restart. Postgres is the native
Windows install.

**Why:** Your standing rule that Jarvis is never containerized, plus simpler GPU access for the
speech engines and simpler access to the `claude` CLI login.

## D9. React for the web UI (2026-10-01, superseded by D17)

**Decision:** React 19 with Vite.

**Alternatives:** SolidJS (Macro's choice, which would allow lifting Macro UI code); vanilla JS
(the old Jarvis page).

**Why:**
- The largest ecosystem for the pieces we need (rich-text editors, Excalidraw, virtualized lists,
  accessible primitives).
- The same stack as Handy, so the desktop app and the workspace can share components.
- What Claude Code writes most reliably.

Macro's SolidJS components can't be reused directly anyway, because they depend on its backend APIs.

## D10. Fork Handy for the desktop app and dictation (2026-10-01)

**Decision:** Start the desktop app from [Handy](https://github.com/cjpais/Handy) (MIT, Tauri 2,
React).

**Why:** It already does the hard native parts of a Wispr Flow on Windows:
- a global hold-to-talk and toggle hotkey
- microphone capture with Silero voice activity detection
- local Whisper (GPU) and Parakeet engines
- paste-into-any-app with clipboard restore
- dictation history

We add the workspace connection, cleanup, dictionary, snippets, styles, command mode and meeting
capture.

## D11. Choose the speech engine by measurement (2026-10-01)

**Decision:** Before building on any engine, run a bake-off on your own recorded speech and
vocabulary. Only local engines take part, unless you allow a cloud fallback.

**Why:** You're not satisfied with Jarvis's faster-whisper setup, and Jarvis's own rule was
"measure before deciding". The harness stays in the repo, so new models can be compared later.

## D12. Name the workspace "Hearth" (2026-10-01)

**Decision:** The workspace is called Hearth. "Jarvis" stays the agent's name only.

**Why:** You asked for Jarvis to name the agent only and left the workspace name to me. A hearth
is the center of a home, where everything gathers, and it's where Jarvis lives. It's short, works
as a command (`hearth doctor`), and isn't a well-known software brand. Rename freely.

## D13. Local speech only, NVIDIA Parakeet favored (2026-10-01)

**Decision:** No cloud speech engines. NVIDIA Parakeet TDT 0.6B v3 is the expected default for
dictation, meetings and voice chat, confirmed by a short bake-off against today's Whisper
large-v3-turbo setup on your own recordings. Refines D11.

**Why:** You want running costs at or near zero, and Jarvis's rule was that audio never leaves
the machine. Parakeet is fast on the CPU, small on the GPU, openly licensed (CC-BY-4.0) and
already built into Handy. It can't take a vocabulary prompt the way Whisper can, so the personal
dictionary is applied in the cleanup pass.

## D14. Drop the old Jarvis page and bridge constraints (2026-10-01)

**Decision:** The workspace uses a JS framework with a build step, WebSockets for doc sync, and
separate processes for voice and the agent. Loading code from CDNs stays banned: everything is
bundled and served locally.

**Why:** You confirmed it. Those rules fit a single phone page, not a workspace with real-time
docs, an email client and a canvas.

## D15. Gmail first, behind a provider interface (2026-10-01)

**Decision:** M2 ships only a Gmail adapter (your two accounts). Everything above sync talks to a
`MailProvider` interface, so Microsoft 365 (Graph) and IMAP/SMTP are each one more adapter later.

**Why:** You have no other accounts today but want other providers to be easy to add. Building
the interface now costs little; building the extra adapters now would be unused work.

## D16. Offsite backups to Google Drive (Google One) (2026-10-01)

**Decision:** Nightly encrypted backups with restic, stored in your Google Drive through restic's
rclone backend, using the `drive.file` scope. A monthly automatic restore test reports in the brief.

**Why:** You already pay for Google One, so offsite backup costs nothing extra. Restic encrypts
before upload, so Google holds only ciphertext.

## D17. SolidJS for the web UI, replacing React (2026-10-01)

**Decision:** Hearth's web UI uses SolidJS, Vite, Tailwind v4 and Kobalte. Supersedes D9.

**Why:** The Macro research showed that its best frontend pieces lift out almost unchanged, but
only into a SolidJS app:
- the split-pane router (4.7K lines, no app imports)
- the hotkey engine behind shortcuts and Cmd+K
- the UI kit and color-token theming
- the Lexical editor and its collaboration binding
- the canvas

Taking them saves weeks and gives Hearth Macro's feel from M0. The doc-sync and email-renderer
packages are framework-free and would work either way. React's larger ecosystem mattered mainly
for an editor and a canvas, and Macro now supplies both.

**Trade-off:** The Handy-based desktop app keeps its small React settings and overlay windows.
Its main window loads Hearth's SolidJS UI, so the two codebases don't share components.

## D18. Docs on Lexical and Loro, using Macro's packages (2026-10-01)

**Decision:** Docs use Lexical with the Loro CRDT through Macro's `lexical-core`,
`collaboration` and `loro-mirror` packages. A sync room in `hearth-server` (TypeScript, Loro's JS
engine) speaks Macro's protocol and persists to Postgres.

**Alternatives:** TipTap with Yjs (MIT, bigger ecosystem, but every piece Macro already built
would have to be rebuilt); porting Macro's Rust sync service to a standalone Rust process (fine,
but adds a second server language); running Macro's Cloudflare worker locally under `wrangler`
(zero code, but not a supported production runtime).

**Why:** Macro's stack already does what we want: offline editing, catch-up by version vector,
history from Loro time-travel, block IDs for citations, and an AI co-editor with a cursor. Only
the room server is Cloudflare-specific, and its portable core is small. Two of Macro's flaws get
fixed on the way: mention links are derived on the server, and the op log is compacted.

## D19. Hearth is licensed AGPLv3 (2026-10-01)

**Decision:** Hearth's own code is AGPLv3. Supersedes the `vendor/agpl/` isolation idea in
plan draft 1.

**Why:** Hearth copies a lot of Macro code (shell, editor, sync, canvas, renderer), so isolating it
would be busywork. AGPL's obligation is to share source with people who use the software over a
network. Only you use Hearth, so it costs nothing in practice. If you ever wanted to sell Hearth
closed-source, the Macro-derived parts would need replacing or a commercial license from Macro.
`NOTICE.md` will list every borrowed file and its origin.

## D20. Use Macro's canvas, not Excalidraw (2026-10-01)

**Decision:** The canvas is Macro's `block-canvas`. Supersedes the Excalidraw choice in plan draft 1.

**Why:** It's SolidJS (Excalidraw is React), already embeds @linked records as cards, and only 5
files outside it import it, so it lifts cleanly. Its whole-board last-write-wins saving is a real
weakness for teams but acceptable for one person; moving it onto Loro is a later option.

## D21. Jarvis's spine lands in M0, and every module meets the Jarvis contract (2026-10-01)

**Decision:** The pieces that make Jarvis reactive and proactive are built in M0, before any
feature module: the event log with per-consumer cursors, the reflex engine, the scheduler,
approvals, the agent runtime, chat, @Jarvis replies and tasks assigned to Jarvis. Every module and
integration must provide events, actions, record descriptions and reflexes (the "Jarvis
contract"), and a test fails when one is missing.

**Alternatives:** Build Jarvis in M1 after the foundations (the previous roadmap); add Jarvis
support to each module after the module ships.

**Why:** You asked for Jarvis to be both reactive and proactive across everything connected to
Hearth. If each module adds Jarvis support afterwards, coverage drifts and some modules end up
with none. Putting the spine first means every later module plugs into it from its first commit.
About a week of work moves from M1 to M0; the total doesn't change.

## D22. A lean shell for M0; Macro's editor and canvas still to be lifted (2026-10-01)

**Decision:** M0's web shell (split panes, hotkeys, Cmd+K) is written fresh, about 600 lines.
Macro's split-router and hotkey engine are not lifted for now. Its doc editor (M4) and canvas (M6)
are still to be lifted as planned (D17, D20). Kobalte is left out until a screen needs its
primitives.

**Alternatives:** Lift Macro's `lib/split-router` (about 5,000 lines) and `lib/core/hotkey`
(about 2,700) as they are.

**Why:** Both are written for Macro's app. They depend on its telemetry, focus signals and
persisted storage, and several files break the 400-line limit. For three panes encoded in the
URL, a small engine is easier to own and test. Moving to Macro's router later is still possible,
because views only touch `layout.open/show/close`.

## D23. A small scheduler on the event log instead of pg-boss (2026-10-01)

**Decision:** Schedules (routines, reminders, debounced checks) live in a `schedule` table. The
worker advances them and writes a `clock.fired` event in the same transaction. Jarvis's turn
queue is the `jarvis_turn` table. Hearth doesn't use pg-boss.

**Alternatives:** pg-boss for cron and queues, as planned in draft 1.

**Why:** Every reaction already flows through the event log and its cursors. Firing schedules as
events keeps that one path, makes each firing exactly-once with the state change, and lets a stale
missed firing be skipped (Macro's rule). The queue Jarvis needs is "one turn at a time per
conversation, reactive first", which a table with `FOR UPDATE SKIP LOCKED` handles in a few lines.


## D24. Jarvis's browser is your own Chrome, through a Hearth extension (2026-10-02)

**Decision:** A small Hearth extension in your everyday Chrome lets Jarvis drive it through
Chrome's debugging protocol (`chrome.debugger`), signed in as you. Jarvis works in its own
"Jarvis" window and tab group, plus any tab you hand it. Hearth shows a live picture of Jarvis's
tab that you can click and type into, on the PC or the phone. The extension connects to the Hearth
server over a WebSocket with a pairing token; Jarvis and the worker reach it through the server.
Every browser step is a Hearth action, so the policy, approvals and audit apply.

**Alternatives:** A separate Chrome profile driven by Patchright, as
[the Polar note](research/polar.md) recommends. Playwright MCP's extension. Claude in Chrome.
Browser Use as a Python sidecar.

**Why:** You want Jarvis in the browser you use, on the sites you're already signed in to, where
you can see it. A separate profile means signing in twice and a window you never look at. Driving
Chrome through our own extension adds no automation flags and no extra runtime, and it keeps the
browser inside Hearth's policy instead of a side door (the note's warning). Accepted costs: Chrome
shows a "debugging this browser" bar while Jarvis is attached; the browser works only while Chrome
is open and you're signed in to Windows; and a successful prompt injection has your real sessions
in reach, which D25 limits.

## D25. Once a turn has read outside content, it can't send data anywhere nobody vouched for (2026-10-02)

**Decision:** After a turn reads outside content (a web page, a search result, a record created by
an outside tool), Jarvis may only open exact web addresses that appeared in what it read, or sites
on your allowed list. Opening anything else in the browser waits for your yes; a web fetch is
refused. Sites on your blocked list are never opened by Jarvis. Reading a record that an outside
tool created now lowers the turn's trust, which it didn't before.

**Alternatives:** Rely on the model resisting prompt injection. Stop all browsing once a turn is
untrusted.

**Why:** With your signed-in Chrome, the danger isn't a page Jarvis reads; it's a page telling
Jarvis to carry your data elsewhere, for example by opening an address with your email in it.
Matching exact addresses stops that without stopping normal link-following, because an attacker
can't know your data in advance. Anthropic's own browser agent still loses about 1% of attacks
from a determined attacker, so the model alone isn't enough.

## D26. Jarvis may sign in to sites without asking (2026-10-02)

**Decision:** When Jarvis can type (browser step 2), it may sign in to a site without your
approval. Hearth's code fills the password from a vault; the model never sees it, and it's only
filled on the exact site it belongs to. Two-factor codes stay with you by default. What Jarvis does
after signing in follows the usual rules. The vault (KeePassXC or Chrome's own saved passwords) is
chosen in step 2.

**Alternatives:** Approve every sign-in, as the Polar note recommends.

**Why:** You asked for it, and with the site check the sign-in itself is low risk: a phishing page
gets nothing, and signing in to the real site sends nothing anywhere. The risk is in what happens
next, and those actions keep their approvals.

## D27. A watched page's text stays on the watch (2026-10-02)

**Decision:** Page watches keep the page's text on the watch record only. Notices and events say
that a watched page changed, never what it says now. Watch records are marked as outside content,
so a turn that reads one is untrusted, and a turn about a change starts untrusted. A watch's
follow-up ("tell me if it drops under $30") is yours: Jarvis can only set one in a turn that
hasn't read outside content. Watches run later without you, so blocked sites are refused even
when you set one up, and a plain-fetch watch Jarvis creates can't reach your own network.

**Alternatives:** Put the new text in the notice, which saves a click.

**Why:** Notices and events are read all over Hearth, by Jarvis and by reflexes, without the
untrusted marking a web page gets. Keeping page text in one place, which is marked, keeps D25
whole. The watch's page shows exactly what changed, one click from the notice.

## D28. Hearth opens your Chrome when Jarvis needs it (2026-10-02)

**Decision:** When Jarvis opens a page and Chrome is closed, Hearth starts your own Chrome, in
your own profile, on your desktop, and waits for the extension to connect. Chrome starts with no
window of its own (`--no-startup-window`); Jarvis's window appears when it opens a page. The
extension asks to keep Chrome running in the background (the "background" permission), so Chrome
stays up after you close its windows, starts when you sign in to Windows, and shows its icon in
the system tray. On Windows, Hearth's server is a service and can't show anything on your
desktop, so it runs a scheduled task, "Hearth Chrome", that install.ps1 registers to run as you,
only while you're signed in; the task also opens Chrome when you sign in. When you run Hearth
yourself (and on a Mac or Linux), it starts Chrome directly. Only opening a page starts Chrome:
listing tabs or using a tab that's gone doesn't. A running Chrome gets a moment to reconnect
first (30 seconds after Hearth starts, 10 after the link drops), and after a failed try Hearth
waits five minutes before trying again by itself. **Open Chrome** in Hearth tries at once.

When Chrome had no windows and is set to continue where you left off, it brings your last
session back into the next window that opens, which is Jarvis's. The extension then leaves that
window to you and moves Jarvis's tabs to a new window.

**Alternatives:** Start Chrome from the service directly (it would run in session 0, invisible,
and lock your profile so your own Chrome wouldn't open). A helper program running in your
session at all times (one more thing running, for the same result). Background mode alone (Chrome
would stay closed after you quit it from the tray). Hiding Chrome's "debugging this browser" bar
with `--silent-debugger-extension-api` (it would hide that bar for every extension, and it's the
clearest sign that something is driving your browser).

**Why:** The browser stays yours and visible: your Chrome, your profile, a window you can see,
never a hidden one. Hearth keeps working after you close Chrome, and you're told plainly when it
can't open Chrome (usually because nobody is signed in to Windows).

## D29. The sign-in vault is Hearth's own, encrypted with a key kept outside the database (2026-10-03)

**Decision:** The logins Jarvis may use live in Hearth's database, in `vault_login`. Each
password is encrypted (AES-256-GCM) with a key from `HEARTH_VAULT_KEY`, or from `vault.key` in the
data folder, which Hearth makes the first time you save a sign-in. Each one is tied to its site
and username, so it can't be moved to another site. You add them in Settings > Sign-ins; only you
can, and the audit log keeps none of it. Jarvis sees sites and usernames, never a password:
`browser.sign_in` decrypts one in code and types it into the password field of the matching site
(that exact site, over HTTPS only; `www.` aside, a subdomain is a different site, since anyone
with a blog or a shop on one could put a form there). Database backups don't include the key, so a
stolen backup gives nothing away, and after a rebuild you save the sign-ins again.

**Alternatives:** KeePassXC through its browser protocol, as D26 suggested. Chrome's own saved
passwords.

**Why:** KeePassXC needs its app open and unlocked after every reboot, a pairing step, and its
own encrypted message protocol, all for a handful of logins. Chrome doesn't let an extension read
its saved passwords at all. Hearth's own vault needs no setup, works unattended after a reboot,
and keeps the same promise: the model never sees a password and a look-alike site gets nothing.
The key file is only as safe as the PC, the same trade KeePassXC's key file would make.

## D30. After reading outside content, Jarvis acts freely only where it went first (2026-10-03)

**Decision:** Clicking, picking from lists and typing don't need your yes. Pressing anything that
sends (a form's submit button, a button named Send, Buy, Post, Delete and the like, or Enter in
most fields) is `browser.submit`, which always does. Once a turn has read outside content,
typing, clicking, choosing and pressing keys go freely only on sites the turn opened before that,
or sites on your allowed list; anywhere else they wait for your yes. Passwords are typed only by
`browser.sign_in`. Hearth refuses to click something covered by another element, checks the
point is still on the element just before the click, and won't move a list's or radio group's
choice with the arrow keys. A submit's approval card shows what the form will send, and the press
is refused if the site, the button's name or any of that changed by the time you say yes. When
an approved step resumes a turn that had read outside content, the turn stays untrusted.

**Alternatives:** Ask before every typing step after reading a page. Let typing go anywhere and
rely on the submit approval.

**Why:** Typing is how data could leave: a page could lead Jarvis somewhere and have it type your
details into a box that sends as you type. A site Jarvis opened before reading anything was your
choice, or its own from your request, so search boxes and forms there just work. Asking before
every keystroke would make the browser useless; asking for none would leave D25 with a gap.

## D31. Your routines run while Jarvis is paused (2026-10-03)

**Decision:** Routines you make (Settings > Routines, or by asking Jarvis) run on their schedule
even while Jarvis is paused, like a watch's follow-up. Only you, or Jarvis in a turn that hasn't
read outside content, can write or change one.

**Alternatives:** Treat routines as Jarvis's own initiative and stop them with the pause.

**Why:** Pausing stops Jarvis acting on its own. A routine is something you asked for, at a time
you chose; skipping it silently would be a surprise. You can turn each one off on its own.


## D32. Mail syncs into Hearth's own tables, threaded by headers, triaged locally first (2026-10-03)

**Decision:** Each Gmail account you connect (Settings > Google, "Connect Gmail too") syncs into
`mail_thread` and `mail_message` through a `MailProvider` (D15). The first sync brings in the last
30 days, up to 1,000 messages, in pages; after that the worker asks Gmail's `history.list` what
changed, every minute. Messages join conversations by Message-ID, In-Reply-To and References, never
by Gmail's thread ids. The raw message is kept on disk under the data folder (`blobs/`, by its
hash); the database keeps the text, sender, recipients, flags and attachment list. Archive, star,
read and trash change Hearth at once and queue the same change for Gmail, which is rolled back (and
you're told) if Gmail refuses it. Mail lands in Signal or Noise by your sender rules first, then
whether you know the person, then Gmail's tabs; once you've written in a conversation it's Signal.
Writing to someone makes them a person. Drafts, spam and chats stay out. Every email is outside
content for Jarvis (D25): reading one through any tool, including a search or a list that only
shows its subject, makes the rest of the turn untrusted, and the news of new mail is untrusted.
The morning brief quotes subjects, so it starts untrusted; the journal and the nightly memory update
leave email out, so it can never become memory. Trashing mail waits for your yes, and the HTML view
is yours only. Disconnecting an account revokes Hearth's access at Google and deletes its mail.

**Alternatives:** Read Gmail live on every screen. Use Gmail's thread ids. Push notifications
through Pub/Sub. Back up the raw messages with the database.

**Why:** Hearth's own copy is what makes one inbox across accounts, search, people and Jarvis
possible, and it keeps working when Google is slow. Header threading works the same for Outlook or
IMAP later. Polling needs nothing on your PC open to the internet. Raw messages are still in
Gmail, so they stay out of the nightly backup to keep it small; after a restore, older mail shows
as text until it's synced again.

## D33. Drafts live in Hearth, and a send is approved as the exact message (2026-10-03)

**Decision:** Drafts are `email_draft` entities with a `mail_draft` row (account, conversation,
recipients, reply headers), saved as you type; Gmail never sees them until they're sent. A reply
draft takes its recipients and `In-Reply-To`/`References` from the conversation, and reply-all
leaves you out. `mail.send` builds the message, sends it through the `MailProvider`, and saves the
sent copy straight into the conversation. Sending is outward, so Jarvis's send waits for your yes.
To make that yes mean the message you read, an action can declare a `snapshot` hook: before asking,
Jarvis's tool call is given the draft's current from, recipients, subject and text, the approval
shows them in full (addresses first, so a display name can't pass for another recipient), and the
send refuses if the draft no longer matches (compared key-order-free, since approvals are stored as
jsonb). Your own Send works the same way: the composer saves what's on screen, Bcc included, and
sends only if the draft still matches it, so a change Jarvis made meanwhile can't ride along. A
send without a snapshot is only taken from you. Display names are always quoted when sent and
stripped of control and direction-changing characters. HTML mail opens from `/api/mail/frame/:id` with its own policy (no scripts, nothing
remote until you ask for images), and attachments only ever download.

**Alternatives:** Keep drafts in Gmail. Approve "send draft X" and send whatever it holds by then.
Show HTML in a `srcdoc` frame.

**Why:** Local drafts work offline and let Jarvis and you edit the same one. Approving a draft by
id would let it change between your yes and the send (by Jarvis, or by a page Jarvis read); the
snapshot closes that gap. A `srcdoc` frame inherits Hearth's own policy, which blocks the images
you ask to see, so the message gets a page of its own.

## D34. "Needs a reply" is a rule, and follow-ups are drafts (2026-10-03)

**Decision:** Each conversation records who it waits on, worked out from its last message whenever
it changes: "them" if you sent the last one (Gmail's SENT label, since a From line can be forged);
"you" if a person wrote to you directly (you're in To, it's in
Signal, it isn't in a Gmail tab other than Primary, and the sender isn't an address like
no-reply@ or news@). Saying it needs no reply holds until another message arrives (counted, not dated, since a
sender picks the date). Mail shows these as "To
reply" and "Waiting", the brief counts what needs a reply, and on weekday mornings, for questions
you asked that got no answer in 3 days (up to 30), Jarvis gets one untrusted turn to draft
follow-ups, once per quiet spell. It never sends them.

**Alternatives:** Ask a model which mail needs a reply. Remind you instead of drafting. Send the
follow-ups after a while.

**Why:** A rule is free, instant, and the same every time, so opening Mail never costs a turn
(PLAN.md, projections). A draft is the useful part of a reminder. Sending stays yours (D33).

## D35. Invitations in mail are answered as the calendar's event (2026-10-03)

**Decision:** When a message carries an iCalendar invitation (REQUEST or CANCEL) and comes from the
invitation's own organizer, Hearth keeps its UID, organizer and start, and matches it to the event
on your calendar by UID (Google's own invitations also by event id), only when the organizer is
the same. A cancellation is shown as the sender's claim unless the calendar agrees. The conversation shows the
calendar's title, time and your answer, with Going, Maybe and Not going, which answer the calendar
event (`calendar.respond`, so Jarvis's answers wait for your yes, naming the meeting on one line, and
aren't sent if the meeting changed after you were asked). An
invitation isn't mail that needs a reply.

**Alternatives:** Answer by emailing an iCalendar reply. Show the email's own description of the
meeting.

**Why:** Gmail already puts invitations on your calendar, and answering there tells the organizer
the same way Google does. The email's text is the sender's, so the card shows only what the
calendar says, and an invitation naming someone else's meeting matches nothing.

## D36. People and companies come from what you do, not what arrives (2026-10-03)

**Decision:** A person is made when you write to someone or meet them in a meeting you organized
or accepted (up to 20 guests); mail you receive and invitations you haven't answered only link
people you already know. A person's first work address makes a company (`company`, keyed by its
domain, named from it), never a free-mail domain or a role account (info@, noreply@). A
`person` row keeps the company, a follow-up in days and your own fields. When you last talked is
worked out from mail you sent them or they sent (not spam, not a stranger copying them in) and
meetings you organized or accepted (not cancelled), never stored,
and the brief says "You haven't talked to X in N days" once a follow-up has passed. People from
before this get their company from a nightly tidy; events get their guests linked on the next
sync. Recording whose an address is (`person.add_email`) waits for your yes in a turn that
read outside content, and a record that names outside records (a person's email subjects) makes
Jarvis's turn untrusted like the outside records themselves.

**Alternatives:** Make people from every sender. Store a last-contact date and update it on each
message. Look up companies online.

**Why:** Following Macro's rule keeps strangers and newsletters out of your people. Working out
the last contact from links means a deleted email or a declined meeting stops counting with no
bookkeeping. Nothing about a person leaves Hearth (PLAN.md section 8.7: no outside enrichment).

## D37. A meeting is notes, a transcript and a summary, linked to the event and the people (2026-10-03)

**Decision:** A `meeting` entity holds your notes (its body), a `meeting` row (the event, start
and end, Jarvis's summary) and `meeting_segment` rows. Segment ids come from the recorder (the
channel and the audio's start), so sending them again replaces rather than duplicates. Only you
and the recorder write the transcript. One meeting per event, linked to the event and to the
people linked to it. Ending a meeting with notes or a transcript gives Jarvis an untrusted turn
to write the summary and make tasks from your action items (publishing again skips tasks it
already made). A meeting is outside content, since the transcript is other people's words. The
prep packet names the last meeting with any of the same guests (or the last time this meeting
happened), with its summary and your notes, and that makes the prep turn untrusted; it does so
only for meetings you organized or accepted, matching guests by address. Tasks made from action
items are written as `integration:meetings`, so they stay outside content wherever they show up.
A turn that read outside content can write a summary once, and asks before starting or changing
meeting notes.

**Alternatives:** Keep the summary in the body. Make meetings only from the recorder. Leave
transcripts out of D25.

**Why:** Your notes stay yours and the summary can be rewritten without touching them. The
recorder (desktop app, M3) only has to post segments and end the meeting. Anything a guest says
could be an instruction, so it's held to the same rules as email.

## D38. Notes are live documents on Loro text, edited in CodeMirror (2026-10-03)

**Decision:** A note's body is a Loro document (`doc_state` holds a snapshot, `doc_update` the
edits since, folded in every 50). The web app edits it in CodeMirror through `loro-codemirror`,
keeps a copy in IndexedDB so it opens and takes edits offline, and syncs with one action,
`doc.sync` (send what the server hasn't seen, get back what you haven't). Other screens hear
about a change through the live event feed and sync at once. The text stays markdown with
`<m-ref>` mentions, so search, backlinks and Jarvis read it as before; the editor shows mentions
as chips and `- [ ]` as checkboxes. When Jarvis (or anything else) changes the body with
`note.update`, the next sync applies the difference as an edit by that writer, so it merges with
typing it didn't see instead of replacing it.

**Alternatives:** Lift Macro's Lexical editor and its packages (about 30,000 lines). Yjs instead
of Loro. Keep last-write-wins bodies.

**Why:** Same CRDT Macro uses, a small fraction of the code, and it rides the sync and event
feed Hearth already has. Loro keeps the full history, which version history (next) needs.

## D39. Note history is Loro's own log, grouped by session, with who wrote each part (2026-10-03)

**Decision:** History stores nothing new for versions: `doc.history` reads the doc's change log
and groups it into stretches of editing (a new version after 10 minutes without an edit). Who
wrote each part comes from `doc_peer`, which records the principal behind each Loro peer when its
edits are first saved (the first claim stands). Named checkpoints are frontiers in
`doc_checkpoint`. Restoring writes the old text back as a new edit by you, so every later version
stays in the history. History, preview, restore and checkpoints are yours only for now.

**Alternatives:** Store a copy of the text per version. Restore by rewinding the doc (loses what
came after). One version per change (too many to scrub).

**Why:** Loro already keeps every edit, so this costs a small table, and restore can't lose work.

## D40. Jarvis edits notes in place, and memory notes are live docs (2026-10-03)

**Decision:** `doc.edit` (Jarvis's `doc_edit`) changes part of a note through its Loro doc:
replace or insert after text found exactly once, or append, as Jarvis's own peer, so it merges
with typing and shows on open screens with a labelled caret where the change landed. It works on
notes only, for you, Jarvis and outside agents over MCP; a passage that isn't there exactly once
is refused rather than guessed. Memory notes are live docs too: the Memory page edits them like
notes, a stretch of typing is one memory version (a new one after 10 minutes), and Jarvis still
changes memory only through `memory_update`, which refuses after outside content (D25). Each
doc type sets its own length limit and how its text is saved.

**Alternatives:** Character-offset ops (the model counts badly). Live cursors for every screen.
Opening `doc.edit` to memory notes.

**Why:** Text anchors are what a model can get right, and refusing ambiguous ones beats editing
the wrong place. Memory keeps its own trust rules.

## D41. Dictation cleanup runs in Hearth: rules first, then an optional local model (2026-10-03)

**Decision:** The desktop app sends what the speech engine heard (and the app and window) to
`voice.clean`. Hearth tidies it with rules (fillers, "scratch that", repeated words), applies
the dictionary, asks a small local model for punctuation and the app's style if one is set up
(`HEARTH_CLEANUP_URL`, any OpenAI-style endpoint such as Ollama on the PC, 800 ms budget),
applies the dictionary again, then expands snippets, so snippet text is never reworded. A model
answer far longer or shorter than the input is thrown away. Every dictation is a `dictation`
record with the raw text kept beside it; fixing one in the history learns short word swaps into
the dictionary. Snippets are records; styles per app are a setting. All of it is yours only:
Jarvis can read dictations but can't add words, snippets or styles.

**Alternatives:** Clean up inside the desktop app (the dictionary and history would live in two
places). A Claude turn for cleanup (too slow for the 1-second target). Rules only.

**Why:** One place holds your words, so the desktop app, the phone and Jarvis share them, and
the rules pass keeps dictation working when the model is off or slow.

## D42. The desktop app pairs with a scoped token; voice commands are bare Jarvis turns (2026-10-03)

**Decision:** The desktop app signs in with a device token made in Settings → Desktop app (or
`hearth device pair desktop`). It acts as you, but:
- the token may only call a fixed list of actions (`voice.clean`, `voice.command`,
  `voice.command_result`, `voice.styles`, `chat.send`, `conversation.get`); every other route
  answers 403, and pairing again signs the old code out;
- its calls are recorded as `via: "device"` with untrusted origin, so a Jarvis turn it starts
  asks before changing your accounts or acting for you;
- it can only read the conversations it started.

Command mode is `voice.command`. The selected text becomes a short-lived `voice_command` record
(outside content), and a fast-lane Jarvis turn with no tools, no web and no memory rewrites it.
The app fetches that turn's reply with `voice.command_result` and pastes it, and the record is
then deleted (unfetched ones go after 15 minutes). `app` must be a program name, never a window
title.

**Alternatives:** An MCP-client token (it isn't you, so `voice.clean` and your dictionary would
be off limits). A full owner token on the desktop (anything that reads its settings file could
then do everything you can). Giving command turns Jarvis's tools (the answer is pasted where
nothing can approve it, so text from an email could make it paste out your data).

**Why:** The desktop app runs beside every other program on the PC, so its token should be
worth as little as possible if it leaks, and a pasted answer is an outward channel with no
approval step.

## D43. The desktop app is Handy, vendored, with Hearth's code kept to one folder (2026-10-03)

**Decision:** `apps/desktop` is a copy of Handy at `ffbc950` (MIT), outside the pnpm workspace
and Hearth's lint and file-size rules, built with Bun and Cargo as Handy is. Hearth's additions
live in `src-tauri/src/hearth/` and `HearthSettings.tsx`; Handy's files get small hooks only, so
upstream fixes can be merged in by hand. Dictation goes through `voice.clean` and falls back to
Handy's own processing when Hearth is down. Command mode and talk mode are two more hotkeys on
Handy's transcribe action. Speech is read with Windows' built-in voice (SAPI). It is renamed
"Hearth Desktop" with its own identifier and Handy's updater off. A GitHub workflow builds the
Windows installer, so the PC installs a file instead of a Rust toolchain.

**Alternatives:** A git submodule or subtree of Handy (harder for the PC and CI to work with,
and every Hearth change would be a patch on someone else's repository). Writing the desktop
app from scratch (Handy already has hotkeys, local Parakeet and Whisper, and reliable paste on
Windows). A cloud or neural voice for answers (not local, or another model to run).

**Why:** Handy does the hard native parts well; keeping Hearth's code apart keeps the fork
cheap to follow upstream.

## D44. The meeting recorder transcribes on the PC and sends text, two channels for who spoke (2026-10-03)

**Decision:** The desktop app records the microphone and a WASAPI loopback of the speakers as
two channels, "me" and "them", so the transcript knows who spoke without a diarization model.
Each channel is cut at pauses (4 to 20 seconds a piece, silence dropped) and transcribed with
the same local engine as dictation; only text goes to Hearth, through `meeting.add_segments`,
with ids made of the channel and the start time so a retry never duplicates. `meeting.record`
picks the meeting: the calendar event on now (or starting within ten minutes), else notes
opened in the last three hours and not ended, else a new one. It returns how far into that
meeting recording starts, so times line up with the meeting's clock. The paired desktop token
gets `meeting.record`, `meeting.add_segments` and `meeting.end`, nothing else from meetings.
No audio is kept.

**Alternatives:** Streaming audio to Hearth to transcribe there (Hearth has no speech engine,
and audio is a lot more to send and keep than text). Keeping the recordings (Granola doesn't
either; the transcript and your notes are the record). Speaker diarization on one mixed
stream (another model, and worse than knowing which device the sound came from).

**Why:** It reuses the engine the bake-off picks, keeps audio on the PC, and the two-channel
trick gives "who said it" for free on calls, which are most meetings.

## D45. The phone is the web app, installed, with Web Push for what needs you (2026-10-03)

**Decision:** M6 starts with the PWA. On a phone-sized screen the web app shows one pane at a
time with a tab bar (Inbox, Tasks, Calendar, Jarvis, More), Jarvis takes the whole screen, and
closing a record goes back to its list. A manifest and service worker make it installable from
Safari's Add to Home Screen; the service worker caches only the app's own files, never the API,
so nothing of yours is stored on the phone. Notifications use Web Push, end-to-end encrypted to
each device with a key pair Hearth makes once and keeps in its settings. Only approvals, the
morning brief, and interrupts the interrupt budget let through are pushed; everything else waits
in the inbox. The server watches the event log for new inbox items and starts from the newest
event, so a restart never re-sends.

**Alternatives:** Pushing every inbox item (the interrupt budget exists so the phone doesn't
buzz all day). A third-party push relay such as ntfy (another service and account, when the
browser's own push works). Waiting for the iOS shell for notifications (Safari supports Web Push
for home-screen apps).

**Why:** It reuses the whole web app, needs no app store or weekly re-signing, and the only
outside party is Apple's or Google's push service, which sees encrypted bytes.

## D46. Phone speech is transcribed by the desktop app, relayed through Hearth (2026-10-03)

**Decision:** The phone and the web record with the browser, convert to 16 kHz WAV, and post
it to `/api/voice/transcribe`. Hearth keeps it in memory until the desktop app on the PC, which
long-polls `/api/voice/jobs/next` whenever it's paired, takes it, transcribes it with the engine
it already has loaded, and posts the text back. If the desktop app isn't running, the phone is
told so at once. Nothing is written to disk. The desktop token's scope gains exactly those two
routes. Talking to Jarvis from the phone reads the answers aloud with the phone's own voice.

**Alternatives:** A separate voice service with its own copy of the model (PLAN.md's sketch:
a second model in the 8 GB GPU, and another Windows service to install and keep running).
The browser's built-in speech recognition (Safari's goes to Apple's servers, against "all
speech runs locally"). Running a speech model inside Node (no good local engine there).

**Why:** One engine, the one the bake-off picks, serves dictation, meetings and the phone, and
the desktop app is always running on the PC anyway.

## D47. The canvas is a lean rewrite that keeps Macro's board format (2026-10-03)

**Decision:** Canvas boards (PLAN.md section 8.6) are a `canvas` record plus a `canvas_board` row
holding the board as JSON: text cards, boxes and circles, link cards, record cards (`entitymention`
nodes that point at a task, note, person or any record) and arrows that are tied to a card's side
or left free. Those are Macro's node and edge shapes, so a board could move to Macro's renderer
later. The web board is Hearth's own (about 900 lines): pan, zoom, pinch, sticky notes, boxes,
arrows, record cards, colors, undo and redo. A board is saved whole 700 ms after you stop (last
write wins, D20), and a save from elsewhere is taken in only when you have nothing unsaved.

Each save also writes the board as markdown into the record's body (cards top to bottom, record
cards as @links, then the arrows), so search, backlinks and Jarvis read a board like a note.
Jarvis has `canvas.create`, `canvas.list`, `canvas.get`, `canvas.save` and `canvas.add`; adding
cards only places them below what's there. Link cards accept only http(s) addresses.

**Alternatives:** Copying Macro's `block-canvas` (about 14,600 lines tied to Macro's file
system, sync service, permission model and UI kit, most of which Hearth doesn't have). Storing
the board on Loro for merges (one person rarely edits one board from two places at once; PLAN.md
already calls that a later option).

**Why:** The parts of Macro's canvas Hearth needs are small, and its dependencies are not. Keeping
its data model leaves the door open without carrying its framework.

## D48. Slack is read in with your own token, polled, and never posted to (2026-10-03)

**Decision:** Slack (PLAN.md section 8.3) connects with the User OAuth Token of a small Slack app
you make from a manifest Settings fills in (read scopes only). The token is sealed with the vault
key (D26), taken only from you in Settings (`slack.connect` is a `secret` action, so the audit log
keeps none of it), and sent only to slack.com. The worker reads Slack every two minutes: the
channel list every half hour, your @mentions through Slack search (thread replies included), and
the 15 channels read least recently, so a big workspace is read in turn within Slack's limits.
A channel's first look brings in three days, quietly.

Each message is a `slack_message` record written by `integration:slack`, an outside type, so
Jarvis reading one makes the rest of its turn untrusted (D25). A message that @mentions you, or a
direct message to you, lands in the inbox once the first sync is done; your own messages never do.
Messages from someone whose Slack email matches a person in Hearth are linked to them, but Slack
never creates people (like received mail, section 8.7). Hearth's own link tags can't be forged
from Slack text. You can stop reading any channel; mentions there still come in.

Jarvis can list and search what was read in (`slack.messages`) and gets your mentions in the
brief. It has no way to post: posting as itself needs a bot user, which can come later behind an
approval.

**Alternatives:** Slack's Events API or Socket Mode (Events needs a public address Hearth doesn't
have; Socket Mode needs a second, app-level token, more setup for little gain at a two-minute
pace). A bot token (it only sees channels it's invited to, and the point is your own Slack).
Reading every channel every round (a workspace with 100 channels would hit Slack's limits).

**Why:** Polling with one read-only token is the least setup and the smallest thing to leak, and
it fits a PC with no public address.

## D49. The GitHub loop reads pull requests with your token and only moves tasks forward (2026-10-03)

**Decision:** GitHub (PLAN.md section 8.4) connects with a fine-grained, read-only personal access
token and a list of repos, both from Settings. The token is sealed with the vault key (D26),
`github.connect` is a `secret` action, and Hearth never writes to GitHub. The worker reads each
repo's 50 most recently updated pull requests every two minutes (the first look goes back two
weeks). A pull request that names a task (T-123 in its title, branch or description) is saved as
a `github_pr` record, an outside type. Only your own pull requests (the token owner's) are linked
to tasks and move them; anyone can open one on a public repo, and a maintainer can merge it. When
one of yours changes state:
- opened: the task moves to In Review;
- merged: the task moves to Completed;
- a Completed or Canceled task is never moved, and nothing happens while a pull request's state
  stays the same, so a task you move back by hand stays where you put it.

Each move is a quiet inbox note on the task.

**Alternatives:** Webhooks (Hearth has no public address). The GitHub app or OAuth (more setup
for one person's repos). Moving tasks on anyone's pull request (anyone can open one on a public
repo and name a task).

**Why:** It's the loop the plan asks for with the least access: read-only, a few repos, and only
forward moves that a person with access to the repo caused.

## D50. Notion comes in as an uploaded export, written by the import, not as a live link (2026-10-03)

**Decision:** Notion import (M7) takes the zip Notion makes with Export → "Markdown & CSV"
(subpages included), uploaded from Settings. It is opened in memory on the server, reading only
`.md` and `.csv` files, one level of zips inside the zip, at most 5 MB a file and 300 MB in all
(sizes are checked before anything is inflated). Each page becomes a note, subpages under their
page, each database a note holding its table (up to 1,000 rows) with its row pages under it, and
links between pages become @mentions. Images and attachments stay in Notion and are marked where
they were. Everything hangs under one "Imported from Notion" note, and `notion.undo_import`
moves the whole import to the trash.

The notes are written by `integration:notion`, so Jarvis reads them as outside content (D25): a
team's pages are other people's words. Only the upload route, for you, can run the import;
Jarvis can't.

**Alternatives:** Notion's API with an integration token (it sees only pages shared with the
integration, needs a token kept in Hearth, and invites a sync nobody asked for). Treating
imported pages as your own writing (a team page could then steer Jarvis).

**Why:** An export needs no credentials and moves everything at once, which is what an import is.

## D51. Spreadsheets are cells as typed, worked out by IronCalc on both sides (2026-10-03)

**Decision:** A spreadsheet stores only what you typed in each cell (values and =formulas), per
sheet, as one JSON workbook saved whole (last write wins, D20). IronCalc, an open-source engine
in Rust compiled to WebAssembly, works out the formulas: in the browser as you type (loaded only
when a spreadsheet opens) and on the server, which writes the results as markdown tables into the
record's body for search, backlinks and Jarvis. Jarvis edits with sheet.set, a few cells at a time
by name ("Budget!B3"). Sheets are capped at 500 rows by 52 columns, and 20 sheets.

**Alternatives:** Our own formula parser (Excel's functions and their edge cases are a project of
their own). Storing results (they go stale whenever a formula's inputs change). A live-merged
cell document like notes (spreadsheets are rarely edited by two people at once; saving whole is
simpler and matches canvas boards).

**Why:** One engine in both places means what you see is what Jarvis reads.

## D54. Jarvis fails loudly and retries only safe failures (2026-10-04)

**Decision:** Every Jarvis turn ends in a recorded outcome: done, failed, stopped, skipped, or
queued again. A failed turn also records what kind of failure it was (`error_kind`) and how many
attempts it took (migration 0024). The failure kinds are:

- **Safe to retry:** rate limit, overloaded, network, crashed. Hearth tries again after 1, 5 and
  15 minutes, or when a usage limit says it lifts. It only retries while no tool has run yet, so
  nothing is done twice.
- **Not retried:** a rejected tool, any other rejected request, a sign-in problem, or a timeout.
  Sending them again would fail the same way, or cost the same again.
- **Lost session:** starts once more from a recap Hearth writes from the conversation.

When Jarvis restarts in the middle of a turn, the turn runs again only if it hadn't used a tool.

Each failure says, in plain words in the conversation, what happened and what happens next, and
the latest one offers Retry. A routine that has a plain version (the brief) publishes that if
Claude can't manage it within 30 minutes. Failures go to the inbox once per run of failures, and
again at three in a row; a run that ends and starts again alerts afresh. Jarvis's health in
Settings comes from its latest finished turns, not from whether its process is up.

Jarvis is bounded and stoppable:

- **Time limits:** a turn gets 10 minutes in the fast lane, 30 in the deep lane, and 2 for a
  voice command.
- **Stop:** cancels what's waiting, and tells a running turn to stop. The Jarvis process is told
  through LISTEN, and the turn row also records the request in case that signal was missed.
  Pressing Stop while Jarvis is down lets go of messages it hasn't seen yet.
- **Expiry:** a chat is let go after an hour unanswered, and a voice command after two minutes.
  Both are counted from when you asked, not from when Jarvis got to it. Retry asks again, so it
  starts the clock afresh.

The Jarvis process writes `jarvis.alive` every 30 seconds. If that goes three minutes stale, the
worker's watchdog runs the "Hearth Jarvis" task, no more often than every 15 minutes, and tells
you. Only the installed worker on Windows restarts Jarvis. If it still won't stay up, that
becomes an interrupt. The web app reads the same setting: a banner in the Jarvis pane, a red dot
on its button, and a note when a message waits 20 seconds without a turn starting.

Smaller fixes in the same change:

- Routines date their work by when they were due, not when they ran.
- The agent's working folder is pinned to `HEARTH_DATA_DIR\jarvis`, so sessions resume after
  restarts. Sessions started from the old working folder fall back to the recap once.
- Each attempt is a line in `HEARTH_DATA_DIR\logs\jarvis-turns.jsonl`.
- Tool schemas sent to Claude carry no uuid patterns; Hearth still checks every input when the
  tool runs. A rejected schema names the tool. A live probe (`HEARTH_LIVE_PROBE=1`) checks that
  Claude accepts every tool.
- The fast lane runs on Sonnet (`HEARTH_JARVIS_FAST_MODEL`), and the deep lane on Opus
  (`HEARTH_JARVIS_MODEL`). Each setting now covers only its own lane.

The interrupt budget closes three gaps:

- An interrupt held for quiet hours goes out when they end, unless you've already seen it, and
  it reaches the phone as D45 pushes delivered interrupts. Jarvis sends it; while Jarvis is
  down, the worker's watchdog does, so "Jarvis won't stay running" doesn't wait on Jarvis.
- Counting and delivering take one lock, so two processes can't both take the day's last slot.
- A deadline given by a turn that read outside content, or by an outside agent, is shown, but
  it can't wake you.

**Alternatives:**

- Retrying every failure a few times. A bad tool or an expired sign-in fails the same way every
  time, and burns usage while you wait.
- Retrying turns that had already used tools. They could send or create something twice.
- Leaving restarts to the Windows task alone. A process that exits cleanly, or is never started
  again after an update, stays down silently.
- Restarting a process that is running but hung. The watchdog can't tell a hung Jarvis from a
  busy one by its process, and a turn's time limit already ends a stuck turn.

**Why:** The owner relies on Jarvis daily. A silent failure is worse than a loud one: you can
act on a loud one, while a silent one leaves you waiting on something that will never come.
Retrying only what is safe keeps recovery from doing harm.

## D55. Google calls share one paced budget; a slowdown isn't a failure (2026-10-04)

**Decision:** Every Gmail and Calendar call is written to a ledger in the database
(`google_spend`) before it goes out, and Hearth's server, worker and Jarvis all pace against it:
about 400 Gmail units a rolling minute per account for everyday work (a fetch is 5, a history
read 2, a batchModify 50), with 100 more kept for sending, and Calendar on its own allowance. A
call the minute can't take fails at once as "paced"; nothing waits inside a transaction. When
Google still says slow down (a quota 429 or 403), the account's service is paused for every
process for at least a minute (`google_quota`) and the limit Google names is logged. Every
request gives up after 30 seconds.

Mail sync brings mail in a batch at a time and saves each message as it comes, keeping what's
left on the cursor, so a stop anywhere loses nothing and nothing is fetched twice. Only new mail
and mail moved back to the inbox is fetched; flags come from Gmail's history. Each account syncs
in its own action under a lock, and the worker gives mail at most 50 seconds a minute.

A mail account is ok, catching up, paused or failing. A pause is not a failure: no event, no
notice, and the page says it calmly ("Gmail asked Hearth to slow down; resuming at 3:42 p.m.").
The alert comes only when access needs reconnecting, or after three failures in a row with
nothing synced for half an hour, and the first good sync closes it.

**Alternatives:** Retrying with backoff inside each call (it held transactions open while it
slept, and three processes backing off alone still overran the limit together). A limit per
process (the three don't know about each other). Counting a slowdown as a failure (that's what
raised the alert that never closed).

**Why:** Gmail turned Hearth away at about 510-600 units a minute (2026-10-04), far under its
documented quota, and the failures that followed made it worse. One shared budget a little under
what Google allows keeps Hearth from asking too much, and the owner hears only about trouble
that needs them.

## D56. Owner reads skip the audit log; sessions slide (2026-10-04)

**Decision:** An action that only reads (`risk: "read"`), called by you from your own screens or
the CLI (`kind: "owner"`, `origin: "owner"`), writes no audit row when it succeeds. Everything
else is still audited, reads included: Jarvis, outside agents (MCP), integrations, jobs, and
paired devices (which act as you but under outside rules, D42). Failures and refusals are always
audited, whoever called. Nested calls (`ctx.call`) follow the same rule. The read still runs in
an ordinary transaction, not a READ ONLY one: a few reads record what they did as events
(`browser.open` notes the tab it opened), and those must commit with them. A transaction that
writes nothing gets no transaction id and its commit flushes nothing to disk, so in practice
your reads are now just reads.

A browser sign-in now lasts 30 days from its last use instead of 30 days from sign-in. Using it
moves `expires_at` to 30 days from now and sends a fresh cookie. "Last seen" (and that slide) is
written at most every 5 minutes per session, guarded in the database so requests arriving
together write it once; a failure to write it never signs anyone out. API, device and internal
tokens keep the life they were given. The live feed re-checks its session every 20 s and ends
when it's revoked, signed out or expired, but watching doesn't count as using: an open tab
alone never keeps a session alive.

**Alternatives:** Keep auditing every read (a write and a disk flush on every screen you open,
for rows nothing reads: Activity is built from Jarvis's turns, not the audit log). Sample owner
reads. Force owner reads READ ONLY (breaks `browser.open`). Fixed 30-day sessions (you're
signed out mid-week while using Hearth daily) or a long fixed life (a forgotten device stays
signed in).

**Trade-offs:** The audit log no longer shows what you looked at, only what you changed and what
failed; what Jarvis and outside agents read is still there in full. A stolen session cookie now
stays good for as long as it keeps being used, rather than for at most 30 days. It is still
HttpOnly, SameSite=Strict and Secure on https, and signing out revokes it. "Last seen" can be up
to 5 minutes stale.

**Why:** Most requests are your own reads, and each one was also a write. Sliding sessions are
what a daily-use app needs, and the throttled write that keeps "last seen" carries the slide, so
it costs nothing extra.

## D57. Deploys are gated by deep health and roll back; CI covers Windows (2026-10-04)

**Decision:** An update is good only when the new code proves it, and `hearth doctor` tells the
truth about the running install.

- **Deep health.** Every web build stamps `version.json` (commit, build time, the migrations it
  expects). `GET /api/health/deep`, for you or for programs on the PC itself (straight to
  127.0.0.1: nothing through Tailscale Serve or any proxy, and a loopback Host header), reports
  that commit, whether the database is reachable and has exactly the migrations the code
  expects, every health component judged by age (one quiet for twice its interval is failing,
  whatever it last said), Jarvis's last day of turns, and the Chrome link. An open page that
  sees a different build says "Hearth was updated" with Reload.
- **Services refuse a mismatched database.** `hearth serve`, `worker` and `jarvis` compare the
  database's migrations with their own before starting; on a mismatch they log why, report
  themselves failing and exit, and Windows retries them.
- **The update gate.** After an update starts the new code, `update.ps1` waits up to three
  minutes for deep health to report the new commit with every migration applied, and for the
  worker and Jarvis to report in since the restart, not failing (one already failing before the
  update only has to report in: Jarvis's health follows its last turn, which a restart can't
  change, and the update may be its fix). Then the optional Jarvis
  tool-schema probe (`scripts\probe-jarvis-tools.ts`) must pass, if it exists. Then `hearth
  doctor --json` must show no check failing that passed before the update. Otherwise it rolls
  back (migrations down, previous code, restart) and checks the previous version came back.
- **Windows CI.** Every push to the deploy branch and every pull request runs on Windows too
  (Node 22, PostgreSQL 17, as on the PC): lint, types, tests, the build, a server start checked
  through deep health and the doctor, the update gate's logic, and a backup restored into a
  fresh database with restic. The extension's end-to-end tests stay on Linux for now.
- **Backups and restore.** A snapshot holds the dump, mail's stored files and voice samples,
  never `vault.key` (D29); 7 daily, 4 weekly, 12 monthly. `hearth restore` restores into a new
  database in one transaction and never over the one Hearth runs on; switching is a separate,
  stated step (or `--switch`).

**Alternatives:** Requiring a clean doctor after every update (a pre-existing failure, like a
nearly full C:, would block every update, fixes included). Health checks that only ask whether
the server answers (it answered through the whole 2026-10-03 outage). A real Jarvis turn in the
gate (a model call on every update; the tool probe catches the failure we had, more cheaply).
Restoring over the live database (one bad dump and both are gone). A Windows runner of our own
(it would hold secrets on a machine we'd have to keep up; GitHub's runners are disposable).

**Why:** The 2026-10-03 update broke every Jarvis turn while health said "ok", the doctor printed
checkmarks and the updater said "update OK". Each of those now checks the thing that broke.
