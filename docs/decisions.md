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

