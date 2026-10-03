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
(that site or its subdomains, over HTTPS only). Database backups don't include the key, so a
stolen backup gives nothing away, and after a rebuild you save the sign-ins again.

**Alternatives:** KeePassXC through its browser protocol, as D26 suggested. Chrome's own saved
passwords.

**Why:** KeePassXC needs its app open and unlocked after every reboot, a pairing step, and its
own encrypted message protocol, all for a handful of logins. Chrome doesn't let an extension read
its saved passwords at all. Hearth's own vault needs no setup, works unattended after a reboot,
and keeps the same promise: the model never sees a password and a look-alike site gets nothing.
The key file is only as safe as the PC, the same trade KeePassXC's key file would make.

## D30. After reading outside content, Jarvis types freely only where it went first (2026-10-03)

**Decision:** Clicking, picking from lists and typing don't need your yes. Pressing anything that
sends (a form's submit button, a button named Send, Buy, Post, Delete and the like, or Enter in
most fields) is `browser.submit`, which always does. Once a turn has read outside content, typing
goes freely only into sites the turn opened before that, or sites on your allowed list; anywhere
else it waits for your yes. Passwords are typed only by `browser.sign_in`. Hearth refuses to
click something covered by another element, and checks a submit button's name against what you
approved before pressing it.

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

