# Plan: Hearth, a personal Macro with Jarvis built in

Status: draft 4, 2026-10-03. M0 (the spine), M1 (Jarvis's day and the calendar) and Jarvis's browser (B1, B2) are built. M2 (email) is under way: Gmail sync, threading, the Mail page, Signal and Noise, people from mail, drafts, replies, sending with your yes, attachments, needs-reply, follow-up drafts and answering calendar invitations from mail are built. M3 (voice) is next. Research behind it: [Macro](docs/research/macro.md),
[Twenty](docs/research/twenty.md), [Jarvis](docs/research/jarvis.md). Decisions and the
alternatives we rejected: [docs/decisions.md](docs/decisions.md).

## 1. Summary

We're building **Hearth**, a personal workspace: one place for your email, calendar, tasks, docs,
people, meetings, notes and conversations, where everything links to everything. It's modeled
on [Macro](https://macro.com) but built for one person, running on your always-on Windows PC
and reachable from your phone over Tailscale. The name is a placeholder you can change: a hearth
is the center of a home, where everything gathers, and it's where Jarvis lives.

**It costs nothing to run** beyond what you already pay for: your Claude Max subscription, your
Google One storage, and electricity. Speech runs on your own hardware, there are no API keys and
no paid services, and every dependency is open source.

**Jarvis is rebuilt as the workspace's own agent**, not bolted on. Its memory, briefs, prep and
watches become real records in the workspace. Its tools are the same actions you take in the UI,
and anything it does in your name waits for your approval.

**Voice is built in**, with its own engine:
- dictation into any app on your PC (a personal Wispr Flow)
- meeting notes (a personal Granola)
- hands-free conversation with Jarvis

**How we get there: a lean rebuild, not a fork.** Macro is 2.4M lines across ~50 services
built for multi-tenant AWS hosting. Hearth keeps its own core small and lifts Macro's
self-contained pieces as they are:
- the split-pane shell, hotkeys and Cmd+K
- the UI kit
- the doc editor and sync packages
- the canvas
- the email renderer

It also takes ideas and drivers from Twenty and the desktop dictation app from Handy. The goal is a
codebase small enough for one person working with Claude Code to own.

**First milestone (M0):** a workspace shell where you can create a note and a task, @link them,
see the link from both sides, and have Claude Code do the same through MCP. Jarvis's spine lands
in the same milestone, so it answers when you @mention it and acts on its own when something
needs attention, from the first day (section 6.1).

## 2. Goals and non-goals

From your answers on 2026-10-01:

| | |
|---|---|
| Who it's for | Just you. Personal life and work, day to day. |
| Modules in the first usable version | Chat and tasks, email and CRM, docs and canvas, AI agents and memory. Plus Jarvis, dictation, and meeting notes. |
| Must be better than Macro at | Easy self-hosting, more integrations, a simpler and more focused UI, and better AI. |
| Approach | Recommend one. (Recommendation: lean rebuild; see section 3.) |
| Running cost | As close to zero as possible: local speech (NVIDIA Parakeet favored), no cloud services, backups to your existing Google One storage. |
| Email | Your two Gmail accounts now. Other providers (Outlook/Microsoft 365, any IMAP server) must be easy to add later. |

**Non-goals for now:** other users, teams, sharing permissions, billing, a hosted service, an
Android app, and a paid Apple developer account. The data model doesn't block guests later, but
nothing is built for them.

## 3. The approach: lean rebuild

Four options were scored against your goals. Details in [docs/decisions.md](docs/decisions.md).

| Option | Verdict | Why |
|---|---|---|
| Fork Macro and strip it | No | 1.1M lines of Rust and 1.3M of TypeScript, ~50 services, AWS Lambda/SQS/SNS/S3, Kafka, OpenSearch, FusionAuth, Cloudflare Durable Objects for docs, multi-tenant permissions everywhere, Gmail-only email, and a 15-person team pushing daily. One person can't keep a stripped fork alive, and stripping it is most of the work of a rebuild anyway. |
| Twenty as the backbone | No | A great CRM, but it has no inbox, no bidirectional links, and no room for custom docs, canvas or chat UI. You'd live inside a CRM's data model. |
| Grow the current Jarvis | No | Loose files with no data model, 2,000-line modules, and you've judged its core flawed. |
| **Lean rebuild, borrowing from all three** | **Yes** | Small enough to own. Built for one user on one PC from day one. Takes Macro's product ideas, Twenty's integration know-how and Jarvis's behaviors without their weight. |

**License: Hearth is AGPLv3.** Hearth lifts real code from Macro: the split-pane router, hotkey
engine, UI kit, doc editor and sync packages, canvas and email renderer. All of it is AGPLv3, so
Hearth is AGPLv3 too. AGPL only obliges you to share source with people who use the software over
a network, and only you use Hearth, so in practice it costs nothing. If you ever wanted to sell
it closed-source, the Macro-derived parts would need replacing or a license from Macro
(licensing@macro.com). Every borrowed file keeps its notice, and `NOTICE.md` (created in M0) will list
what came from where ([D19](docs/decisions.md)).

## 4. What the product looks like

**One graph.** Every item is a node: an email thread, a message, a task, a doc, a person, a
company, a calendar event, a meeting, a file, a memory note, a Jarvis conversation. @mention
anything from anywhere, and the link shows on both sides. This is Macro's core idea, and it's
what makes the workspace more than a set of separate apps.

**One inbox.** New email, Jarvis results, approvals waiting on you, task due dates, Slack
mentions and follow-ups land in one keyboard-driven list, split into *Signal* and *Noise*:
- `j`/`k` to move
- `e` to done
- `s` to snooze
- `cmd+k` to jump to anything

**Split panes.** Macro's window manager idea: draft an email next to the thread you're answering
and the doc it refers to.

**Jarvis everywhere.**
- a chat pane on every screen
- the morning brief at the top of the inbox
- an approval inbox for anything sent in your name
- prep packets attached to calendar events
- voice from the desktop and the phone

**Calm by default.** Your interrupt budget carries over: at most 8 interrupts a day, quiet hours
from 10 p.m. to 8 a.m., and a deadline within 24 hours always breaks through.

## 5. Architecture

### 5.1 What runs where

Everything runs natively on your Windows PC. Nothing is containerized (your rule), and nothing
is exposed to the public internet.

```
 Phone (PWA, later the iOS shell)        Laptop / any browser
          │                                     │
          └───────────── Tailscale HTTPS ───────┘
                              │
 ┌─────────────── Windows PC (always on) ────────────────────────────┐
 │                                                                   │
 │  hearth-server (Node, TypeScript)                                 │
 │    HTTP API · SSE event stream · WebSocket doc sync · MCP server  │
 │    action registry · approvals · auth                             │
 │                                                                   │
 │  hearth-worker (Node)                 jarvis (Node, Agent SDK)     │
 │    email/calendar sync, search index,   chat turns, brief, prep,   │
 │    local embeddings, scheduled jobs     heartbeat, journal         │
 │                                                                   │
 │  voice-service (Rust)                 desktop app (Tauri, Rust)    │
 │    speech-to-text for phone and         dictation hotkey, meeting  │
 │    web voice, meeting transcripts       capture, tray, wraps UI    │
 │                                                                   │
 │  PostgreSQL 17 (+ pgvector)           file store (local disk)      │
 └───────────────────────────────────────────────────────────────────┘
          │ outbound only
          ├── Gmail / Google Calendar APIs, Microsoft Graph, IMAP/SMTP, CalDAV
          ├── Slack (read), GitHub
          └── Claude (through your claude CLI login)
```

Each process is a Windows service (via WinSW) that restarts on failure. One command (`hearth doctor`,
inspired by the Remote-phone repo's `phone doctor`) reports what's up and what's down.

### 5.2 Stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript for the server, worker, agent and web UI. Rust only for the desktop app and voice service. No Python. | One language across everything you'll touch most. Rust is where native audio, hotkeys and speech models live. |
| Server | Node 24 LTS, Hono | Small, fast, and runs fine on Windows. |
| Database | PostgreSQL 17 with pgvector and pg_trgm, native Windows install | One store for records, links, full-text search, embeddings, the event log and the job queue. |
| Data access | Drizzle ORM and drizzle-kit migrations | Typed SQL with plain migration files. |
| Jobs and schedules | A `schedule` table fired as events, and a `jarvis_turn` queue ([D23](docs/decisions.md)) | Cron and queues in Postgres, so no Redis, and every firing goes through the event log. |
| API contract | One **action registry** (section 5.4), using Zod schemas | One definition per action produces the UI API, the MCP tool and the approval policy. |
| Web UI | SolidJS, Vite, Tailwind v4, TanStack Solid Query | Lets Hearth lift Macro's doc editor and canvas as they are ([D17](docs/decisions.md)). M0's shell (split panes, hotkeys, Cmd+K) is a lean rewrite ([D22](docs/decisions.md)). |
| Docs editor and sync | Lexical with the Loro CRDT, using Macro's `lexical-core`, `collaboration` and `loro-mirror` packages; a sync room in `hearth-server` speaking Macro's protocol | Offline editing, live sync across devices, history and Jarvis as a co-editor, already proven in production ([D18](docs/decisions.md)). |
| Canvas | Macro's canvas (`block-canvas`, SolidJS), which already embeds @linked records | Same framework; one-user last-write-wins saving is acceptable ([D20](docs/decisions.md)). |
| Search | Postgres full-text plus trigram plus pgvector, fused with reciprocal-rank fusion; embeddings from a small local model (nomic-embed-text class) run by the worker | Keyword and meaning search, free and local. |
| Desktop | Tauri 2, starting from a fork of [Handy](https://github.com/cjpais/Handy) (MIT) | Handy already has a global push-to-talk hotkey, local Whisper and Parakeet, voice activity detection, and paste-into-any-app on Windows. Its own small settings and overlay windows stay React; the main window loads Hearth's web UI. |
| Speech | `transcribe-rs` and whisper.cpp engines (the ones Handy uses), behind one engine interface | Swappable; picked by a bake-off on your own voice (section 7.1). |
| Agent | Claude Agent SDK (TypeScript) | The same harness Jarvis uses today, with hooks for the approval gate. |
| Remote access | Tailscale Serve (HTTPS on your tailnet) | Already how you reach the PC. |

### 5.3 Data model

Five core tables carry the whole product; each module adds its own tables.

- **`entity`**: one row per node. Fields: `id`, `type`, `title`, timestamps, `created_by` (you,
  Jarvis, an integration, an MCP client), soft delete, a full-text vector and an optional
  embedding. Module tables (`email_message`, `task`, `doc`, `person`, ...) hang off `entity.id`.
- **`link`**: `from_id`, `to_id`, `kind` (mention, attachment, parent, property-ref, reply,
  derived-from, participant), an `anchor` (where in the source the mention sits), and who made it.
  Unique on (from, to, kind, anchor) and indexed both ways, so backlinks are one query. This is the
  graph.
  - Mentions live inside content as Macro-style tags (`<m-ref type="doc" id="...">label</m-ref>`),
    so markdown stays portable and Jarvis can write a link by writing text.
  - On every save, from the UI, Jarvis or an importer, the server re-derives that item's mention
    links in the same transaction. Macro relies on the web editor to report mentions, and its
    links drift; ours can't.
- **`property`** and **`property_def`**: typed custom fields on any entity type (status, priority,
  due date, stage, tags), with system properties seeded at fixed IDs, as Macro does. Saved views
  store a filter in one small filter language (And/Or/Not over typed conditions, ported from
  Macro's `filter_ast`), which the UI, saved views and Jarvis's tools all share.
- **`event`**: an append-only log of everything that happens, with a global `seq`. It drives live
  updates to the UI, Jarvis's "what changed" deltas, the audit trail and undo. The envelope comes
  from Jarvis's bridge protocol: `seq`, `kind`, `entity`, `actor`, `payload`.
- **`notification`**: the inbox. Each event that needs you writes a notification with the state
  unseen, seen or done, plus an optional snooze time. The inbox shows the latest live notification
  per item (Macro's model). Signal or Noise comes from a cheap flag: Gmail's categories,
  overridden by your per-sender and per-domain rules, with "mark sender as noise" as a one-key
  action.

### 5.4 The action registry

Every operation in the workspace is declared once:

```ts
defineAction({
  name: "email.send",
  input: z.object({ draftId: z.string() }),
  risk: "outward",            // read | internal | self-external | outward | destructive | secret
  handler: async (input, ctx) => { ... },
})
```

Macro does the same with one tool registry across chat, agents and MCP. From that one
definition the workspace generates:
- the typed API the web UI calls
- an MCP tool for Jarvis and for outside agents like Claude Code. It inherits Macro's
  "near-100% of the UI available to agents" by construction.
- the approval rule, so `outward`, `destructive` and `secret` actions from any agent pause in
  your approval inbox
- an audit row and an `event` for every call

### 5.5 Security

- **Login:** a passkey (WebAuthn) for you; per-device sessions; reachable only on your tailnet.
- **Principals:** you, Jarvis, each integration and each external MCP client get their own
  identity and scoped token. Every write records who did it.
- **Approvals:** sending email, posting as you, inviting others, deleting and touching
  credentials all wait for a yes, unless you've written a standing rule (for example "Jarvis may
  reply to calendar scheduling emails from people in my contacts"). Your own calendar is
  `self-external`: Jarvis writes it directly, per your rule.
- **Caller tiers:** a request that arrives through Slack or email is never treated as you. Other
  people get a read-only tier, and Jarvis answers them as itself. This closes today's biggest
  Jarvis hole.
- **Untrusted content:** text from email, Slack, web pages and files is marked as data in every
  tool result and can never raise an action's permissions.
- **Secrets:** OAuth tokens are encrypted at rest with a key held in Windows DPAPI. They are never
  printed or logged.

### 5.6 Backups

This is the main fix for "everything lives on one PC", and it uses the Google One storage you
already pay for:
- **Nightly:** a `pg_dump` plus the file store, backed up with [restic](https://restic.net)
  (deduplicated, versioned) to Google Drive through restic's [rclone](https://rclone.org) backend.
- **Private:** restic encrypts everything on the PC before upload, so Google stores only
  ciphertext. The restic password lives in Windows Credential Manager, with a printed copy
  somewhere safe; without it, backups can't be restored.
- **Least access:** rclone uses the same personal Google Cloud OAuth app as Gmail, with the
  `drive.file` scope, so it can only see the files it created.
- **Retention:** 7 daily, 4 weekly and 12 monthly snapshots. Restic's deduplication keeps this
  small; expect a few GB for the first year, mostly email attachments and meeting audio.
- **Restore test:** a monthly automatic restore into a scratch database, with the result reported
  in the brief.
- **Optional second copy:** an external USB drive.

## 6. Jarvis, rebuilt as the workspace's agent

Jarvis keeps its name, its mandate and your rules ([docs/research/jarvis.md](docs/research/jarvis.md)).
Everything else is new.

### 6.1 Reactive and proactive, across everything

Your ask (2026-10-01): Jarvis should both respond and take initiative, for everything connected to
Hearth. That's part of the foundations, not added feature by feature ([D21](docs/decisions.md)).

**The Jarvis contract.** Every module and every integration provides four things, and a test
fails if any is missing:
- **Senses:** typed events for everything that happens in it (a mail arrived, a task slipped, a
  meeting ended, a sync failed).
- **Hands:** its actions in the registry, each with a risk class, so Jarvis can do anything you
  can do in the UI.
- **Knowledge:** a text description of each of its records, with links, so Jarvis can read and
  cite them.
- **Reflexes:** rules for what Jarvis should notice in its events and what to do about them.

**Reactive.** Jarvis responds when:
- you talk to it: the chat pane, "Ask Jarvis" in Cmd+K, voice, or the phone
- you @mention it anywhere: a note, a task, a comment, a doc. It answers in that thread.
- you assign it a task. It works the task, posts progress there, and moves it to In Review.
- you answer something it asked: an approval or a question
- something it was asked to watch changes

**Proactive.** Jarvis acts on its own when:
- a routine comes due: prep, the brief, the heartbeat, the journal, the nightly memory update, the
  weekly review
- an event matches a reflex: a deadline is close, a follow-up went quiet, a meeting ended, a sync
  broke, a backup failed
- time passes: tasks go overdue, you haven't talked to someone in a while, a login is about to
  expire

**Cheap first.** Every event goes through the same ladder, and a model turn is the last step:
1. Rules match the event against reflexes and watches, with no model call. Most events stop here.
2. Duplicates merge, small items are batched for the next heartbeat, quiet hours apply, and the
   daily turn budget is checked.
3. Only then does Jarvis get a turn, with the event, the linked records and its memory.
4. A turn ends in one of five outcomes:
   - *act*, within its permissions
   - *ask*, as an approval in your inbox
   - *tell*, as a notification, within the interrupt budget
   - *note*, an observation saved for the brief
   - *nothing*

**What it covers:**

| Area | Reactive | Proactive |
|---|---|---|
| Tasks | Creates, updates and plans tasks; works tasks assigned to it | Warns before deadlines, sweeps overdue tasks into the brief, time-blocks big tasks, nudges stalled ones |
| Notes and docs | Answers @Jarvis in place, edits as a co-editor, summarizes, turns checklists into tasks | Spots unchecked action items and offers them as tasks |
| Inbox and approvals | "What needs me?", triage on request | Puts the brief at the top, summarizes waiting approvals, learns Signal and Noise from your choices |
| Email (M2) | Drafts replies, finds and summarizes threads | Flags mail that needs a reply, follows up on threads that went quiet, links mail to people and tasks |
| Calendar (M1) | Schedules, moves and RSVPs, writing your calendar directly | Prep packets, conflict warnings, time blocks, buffers between meetings |
| People (M5) | "What's going on with X?" | "You haven't talked to X in 60 days," keeps person notes current from mail and meetings |
| Meetings (M5) | Summarizes, pulls out action items | Prep before, summary and tasks after, follow-up drafts |
| Voice (M3) | Command mode, hands-free chat | Reads the brief aloud |
| Slack and GitHub (M7) | Answers as itself when @mentioned; others get the read-only tier | Flags concerns, links PRs to tasks, moves tasks on merge |
| Hearth itself | "Is everything working?" (`hearth doctor`) | Reports failed syncs, expiring logins, failed backups, restore tests, and its own turn usage |

**Guardrails**, gathered in one place:
- risk classes and approvals (section 5.5)
- caller tiers: an event from outside never acts as you
- the interrupt budget and the daily turn budget
- a pause switch that stops all proactive work at once
- an activity feed of everything Jarvis did and why, with undo where the action allows it

### 6.2 How it's built

**Runtime.** A Node service on the Claude Agent SDK, logged in through your `claude` CLI (Max
subscription, no API key). Per Anthropic's Agent SDK docs, that login can't be offered to other
users in a product, so this stays strictly personal. Switching to an API key is one config line
if that ever changes.

**Conversations** are workspace entities. Each one is stored as an append-only log of Agent SDK
events and rendered by a pure "fold" function, Macro's pattern, so a live stream and a reload look
identical. Every turn also goes through the event log, so the web UI, the phone and voice show the
same live conversation, with full history that's searchable and never capped at two days.

**Tools** are the action registry, served to the SDK as an in-process MCP server, plus a few of
Jarvis's own:
- `observe`: record an observation. It returns a fixed acknowledgement, so findings can't leak
  into replies.
- `remember`: write a memory note, with a revision.
- `show`: put a card, a record or a live component into a pane mid-answer. This is the "dynamic
  screens" piece the old Jarvis specified but never built.
- `escalate`: hand a question from the fast lane to the deep lane.
- `read_doc` and `apply_doc_ops`: read a doc as markdown with block IDs, and edit it through a
  small set of deterministic operations as a live co-editor with its own cursor. Ported from
  Macro's AI editing worker, minus its API-key model chains.

Outbound tools follow Macro's safety rule: an agent's "send email" produces a draft, and sending
requires your approval. External MCP clients such as Claude Code never see send tools at all.

**Memory** becomes records:
- `memory_note`: identity, how you work, your preferences, and project briefs, each with a
  revision history in place of git commits.
- `observation`: kind, TTL, supersedes, linked to what it's about.
- `fact`: durable facts with a source link.

Retrieval is in tiers:
- always-on notes
- project notes picked by deterministic routing
- a `memory.search` tool using full-text plus embeddings

Memory is injected last, as data, never as instructions.

**Nightly consolidation** borrows Macro's memory loop and fixes its flaws:
- Jarvis gets a deterministic digest of the last 24 hours (mail sent and received, tasks changed,
  docs edited, meetings, observations) plus the current notes.
- It writes updated notes inside `<memory>` tags; a judge pass rejects thin or speculative changes.
- The result is saved as a new revision. A lock prevents double runs, and a failure backs off
  instead of retrying on every read, which is the bug in Macro's version.

**Cached widgets ("projections").** The brief, "needs a reply" and similar panels are
schema-checked agent outputs cached under a prompt hash with a stale time, as in Macro's
`ai_projections`. Opening the inbox never spends a model turn.

**The proactive loop runs on the workspace scheduler:**
- Watching is free. The worker turns sync activity into events, and a `watch` record is just a
  saved filter over them. No model turn is spent until something matches.
- **Prep (6 a.m.):** for each commitment in the next 48 hours, build a `prep_packet` linked to the
  event: last meeting's notes, the thread, the doc, the open tasks.
- **Brief (8:15 a.m.):** a `day_brief` record in the order *handled, prepared, needs a yes*,
  pinned at the top of the inbox and readable aloud.
- **Heartbeat (every 25 minutes, 8 a.m. to 7 p.m.):** one turn only when events, due decisions or
  imminent meetings call for it.
- **Journal (7:30 p.m.):** the day's write-up as a memory note.
- **Time-blocking:** big tasks become real calendar blocks, inside working hours, never over a
  commitment, and never in your evening.

**Lanes.** A warm fast lane for quick questions and a deep lane for heavier work, both on the top
model, as you prefer. Model work shares your Max rate limit, so the scheduler keeps a daily turn
budget and reports usage in the brief.

**"Up to standard" for Jarvis means:**
- No source file over 400 lines. Transport, policy, memory and orchestration are separate modules.
- Every action Jarvis can take goes through the registry, so there are no side doors.
- An eval suite with recorded fixtures covering brief, prep, routing, approvals and
  prompt-injection attempts runs in CI and blocks a merge if scores drop.
- Latency is tracked per lane: time to first token and time to the first spoken sentence.
- Every turn leaves an audit row, and every memory change can be reviewed and reverted.

## 7. Voice

All voice work shares one engine layer with three uses. The engine is a swappable interface,
so the model can change without touching anything else.

### 7.1 The engine: NVIDIA Parakeet, confirmed by a quick bake-off

All speech runs locally and costs nothing. No cloud engines.

**Expected default: NVIDIA Parakeet TDT 0.6B v3.**
- Fast enough on the CPU, faster on the GPU.
- Small enough to share the 8 GB GPU with a cleanup model.
- Openly licensed (CC-BY-4.0).
- Already built into Handy, so it's available on day one of M3.

**One known gap:** unlike Whisper, Parakeet can't be primed with a vocabulary prompt. Your
dictionary is applied in the cleanup pass instead (section 7.2).

Before building on it, a short bake-off confirms the choice on your own voice:
- Record about 50 real dictation samples and 5 meeting clips, with reference transcripts.
- Run Parakeet v3 against today's Whisper large-v3-turbo setup, on GPU and CPU.
- Score word error rate, accuracy on your vocabulary (product names, people, code terms),
  latency from key release to text (median and worst 5%), and GPU memory.
- Parakeet stays the default if it wins. The harness stays in the repo, so any future free model
  is a re-run away.

### 7.2 Dictation: a personal Wispr Flow

Built on the Handy fork. Target: Wispr Flow's core features, private and free.

| Feature | Plan |
|---|---|
| Global hotkey, hold to talk or tap to toggle | Already in Handy |
| Text appears in any app | Already in Handy (paste with clipboard restore on Windows) |
| Removes "um", "uh", false starts and "scratch that" | A fast rules pass, then a small local language model on the GPU. This needs to finish in well under a second, which a full Claude turn can't. |
| Your vocabulary spelled right | A personal dictionary in the workspace: exact replacements ("auto pair" to "OtoPair") plus a list of terms the cleanup model is told to prefer. It learns when you fix a word in the dictation history. |
| Snippets ("my calendar link") | Snippet records in the workspace, expanded by voice trigger |
| Tone per app (casual in Slack, formal in email) | Style profiles keyed by the focused app and window title |
| Command mode ("make this more formal") | Select text, hold the command hotkey, speak. Goes to Jarvis's fast lane; a couple of seconds is acceptable here. |
| History | Every dictation is a workspace record: searchable, linkable, and re-insertable |
| Phone | First the PWA (push-to-talk into any workspace field). Later an iOS keyboard that hands off to the app to record, as Wispr Flow does. |

### 7.3 Meeting notes: a personal Granola

The desktop app records your microphone and the system audio (WASAPI loopback) as two separate
channels. Because you're on one channel and everyone else is on the other, it knows who spoke
without any diarization model. Then:
- A live transcript shows next to your own notes.
- After the call, Jarvis writes the summary using your template.
- The result is a `meeting` record linked to the calendar event and the attendees' person
  records. Action items become tasks.
- Tomorrow's prep packet picks it up automatically.

Pipeline details come from Macro's call service:
- deterministic segment IDs, so re-processing never duplicates
- timestamps anchored to the true audio start, so the transcript and recording stay in sync
- the summary, title and action items written after the call ends

Recording laws vary by state, so the app shows a reminder to tell participants.

### 7.4 Talking to Jarvis

Push-to-talk or hands-free from the desktop or the phone. Audio streams to the voice service, the
transcript goes to Jarvis, and answers come back as text plus local text-to-speech, one sentence
at a time. The old Jarvis's chunked-upload protocol and streaming partials are a proven design to
reuse.

## 8. Modules

Each module ships with its actions in the registry, its views in the UI, its records in the graph,
and its Jarvis skills.

### 8.1 Email (better than Macro's)
- **Accounts:** your two Gmail accounts first, through the Gmail API. The worker polls
  `history.list` every 30–60 seconds, so nothing on your PC has to accept connections from Google.
- **Other providers later, without rework:** everything above the sync layer (threads, triage,
  search, people, Jarvis) talks to a `MailProvider` interface modeled on Macro's ports: list
  changes since a cursor, fetch a message, apply labels and flags, send.
  - Gmail is the first adapter.
  - Microsoft 365 (Graph) and generic IMAP/SMTP are each one more adapter when you need them. Graph
    fits the interface closely; IMAP needs folder-to-label mapping and local threading, and
    Twenty's IMAP driver is a ready reference.
  - Macro supports Gmail only.
- **Local first:** archiving, labeling and snoozing apply instantly in Hearth, then sync to Gmail
  in the background, rolling back on a permanent error (Macro's pattern).
- **Threading** follows RFC headers (Message-ID, In-Reply-To, References), not Gmail's thread IDs,
  so other providers thread the same way.
- **Raw messages** are stored on disk, content-addressed, so they can be re-parsed later without
  refetching.
- **One triage inbox** across accounts, keyboard-first, with Signal and Noise, plus a view per
  account.
- **HTML mail** is rendered with Macro's `email-renderer` in a sandboxed frame, with quote and
  signature folding. Attachments are kept, text-extracted and searchable.
- **Sending** creates a draft; you send it, or approve Jarvis's draft from the approval inbox.
- **Calendar invitations** in mail are parsed once and matched to the live event, so you can RSVP
  from the thread.

### 8.2 Calendar
- **Accounts:** Google Calendar first, with full read and write (create, edit, delete, RSVP);
  Twenty only creates. Microsoft and CalDAV come later through the same adapter pattern as mail.
- **Model:** Macro's design. One canonical event, its provider source, per-occurrence overrides,
  and a materialized occurrence table indexed by time range for fast agendas.
- **Reminders** use a rebuildable schedule plus exactly-once delivery claims, so a moved event
  fires again but a sent alarm never repeats.
- This is what Jarvis's prep and time-blocking stand on.

### 8.3 Chat
For one person, "chat" means three things:
- **Conversations with Jarvis**, any number of them, shared across devices.
- **Notes-to-self channels**, places to think out loud, with @links. Messages have a polymorphic
  parent (Macro's model), so the same thread component also gives comment threads on any doc,
  task, person or meeting.
- **Slack ingest:** team Slack is read in, and your mentions land in the inbox. Jarvis watches
  for concerns and bugs and posts only as itself.

Inviting other people into chat is out of scope for now.

### 8.4 Tasks
- **Fields:** a task is an entity with a doc body, so it gets the editor, mentions, comments and
  search for free. Status, priority, due date, parent and project are typed columns; anything else
  is a custom property.
- **Vocabulary:** status runs Not Started, In Progress, In Review, Completed, Canceled. Priority
  runs Low to Urgent.
- **Views:** list, board and calendar.
- **Create a task from anywhere.** Each one links back to its source:
  - `c t` anywhere in the app
  - `/task` in a doc
  - highlighting a `- [ ]` line
  - "task" on an email or message
  - by asking Jarvis
- **Short IDs** (T-123) and branch names that embed them (`jarvis/T-123-fix-login`), borrowed from
  Macro.
- **GitHub loop:** a PR mentioning T-123 links to the task and moves it forward: In Review when
  opened, Completed when merged. It never overrides Completed or Canceled automatically.
- **Handing code work to Jarvis:** Jarvis works in a git worktree using Macro's handoff prompt
  (task, branch, comment history, conventions), streams progress into the task's thread, and
  records the run on the task. You merge, and only you push.
- **One scheduler** for reminders, recurring tasks, watches and Jarvis routines: one-shot or
  cron plus time zone, idempotent claims, and Macro's rule for skipping a stale missed firing.
  Macro runs three separate schedulers.

### 8.5 Docs
Markdown-native docs with real-time sync across your devices, @links, version history you can
scrub, offline editing, and Jarvis editing as a co-editor. Built on Macro's own stack
([D18](docs/decisions.md)):
- **Editor:** Lexical, with Macro's `lexical-core` nodes (mentions, tags, dates) and markdown
  transforms.
- **Sync:** the Loro CRDT through Macro's `collaboration` package. It keeps an offline
  write-ahead log in the browser, catches up by version vector, and syncs between tabs.
- **Server:** a sync room in `hearth-server` (TypeScript, Loro's JS engine) speaking Macro's
  57-line protocol, so the client packages work unchanged.
  - Each update is persisted to Postgres before it's acknowledged, and ops are compacted into
    snapshots. Macro's op log is never pruned; ours is.
  - Mention links are re-derived from the document on every persist.
- **History:** Loro's built-in time travel (no extra storage), plus restore-in-place and named
  checkpoints.
- **Jarvis as a co-editor:** the `read_doc` and `apply_doc_ops` tools edit through the same CRDT
  with a visible "Jarvis" cursor. For edits made while nobody has the doc open, a
  revision-checked update fails cleanly if the doc changed underneath.
- **Markdown** is the import, export and agent view; the CRDT is the stored form.

The mapper estimated 5–8 weeks for docs, sync, canvas and Jarvis's doc tools with these packages.
Spreadsheets (Macro's IronCalc-based package) can come later.

### 8.6 Canvas
Macro's canvas, which already shows @linked tasks, files and emails as cards on a 2D board. It
saves as one document per board, last write wins, which is fine for one person. Moving it onto
Loro for offline merges is a later option.

### 8.7 People (personal CRM)
- **Built automatically:** people and companies come from email, calendar and Slack, following
  Macro's rules:
  - Mail you send creates a person or company; received mail only updates ones already tracked.
  - Role accounts (info@, noreply@) and free-mail domains never become companies. Twenty's lists
    are a ready reference.
  - Friends on gmail.com still become people; they just don't create a company.
- **Person page:** every linked item (threads, meetings, tasks, docs, notes), plus relationship
  notes, follow-up reminders ("you haven't talked to X in 60 days") and custom fields.
- **Deals** are their own records (company, stage, value, close date) if you want them.
- **No outside data enrichment** unless you turn it on. Company logos come from the domain's
  favicon.

### 8.8 Files and search
- **Files:** attachments, uploads and recordings live on local disk, content-addressed.
  - Text is extracted from PDFs with page positions, so Jarvis can cite a page and the UI can
    highlight it (Macro's citation extractor).
  - Office files convert through a headless LibreOffice when needed.
- **Search:** one query across everything. Each item is indexed as a parent with content chunks
  (a PDF page, a doc block, an email message, a transcript segment), so a hit opens at the exact
  spot.
  - Ranking fuses full-text, title trigram and embedding similarity, with recency as a boost, not
    the only sort. Macro's search is keyword-only.
  - Embeddings come from a small local model, so search costs nothing and nothing leaves the PC.
  - Indexing is a projection: any change means "reread and replace", so it can always be rebuilt.

## 9. What we borrow

Hearth is AGPLv3 ([D19](docs/decisions.md)), so AGPL code can be copied in directly. Every copied
file keeps its notice and is listed in `NOTICE.md`. Full details are in
[docs/research/macro.md](docs/research/macro.md) and [docs/research/twenty.md](docs/research/twenty.md).

| From | What | License | How |
|---|---|---|---|
| Macro | **Frontend shell:** split-pane router (`src/lib/split-router`), hotkey engine (`src/lib/core/hotkey`), `packages/machine`, UI primitives (`src/components/ui`), token theming (`src/index.css`, theme files) | AGPL | Copy, recolor to your palette |
| Macro | **Docs:** `packages/lexical-core`, `packages/collaboration`, `packages/loro-mirror`, the web editor and its collaboration binding, the sync protocol schema, the deterministic parts of `services/ai-editing-worker` | AGPL (loro-mirror upstream is MIT) | Copy; re-host the sync room in TypeScript |
| Macro | **Canvas:** `apps/web/src/features/block-canvas` | AGPL | Copy |
| Macro | **Email:** `packages/email-renderer`, the calendar-invitation parser, the free-mail domain list | AGPL | Copy |
| Macro | **Small pure pieces:** filter language (`crates/filter_ast`), frecency formula, notification state machine, mention tag format, branch-name rules, task-ID patterns, reminder staleness rule | AGPL | Port to TypeScript |
| Macro | **Text:** agent prompt sections (`crates/prompt`), memory and judge prompts, system skills, `TOOL_DESIGN.md`, the coding-agent handoff prompt | AGPL | Adapt |
| Macro | **Schemas as reference:** properties, activity log, calendar events and occurrences, email threads and sender rules | AGPL | Reference |
| Macro | **Ideas:** one graph, Signal/Noise inbox, local-first email actions, CRM-from-sent-mail rule, AI projections, agent session as log plus fold, search as a projection with jump targets, PDF citations | n/a | Design reference |
| Twenty | Field-type and view models, rich-text-to-markdown converters, message ingestion schema, importer apps | MIT | Copy |
| Twenty | IMAP and CalDAV sync drivers, quoted-reply stripping, contact heuristics, push-webhook renewal | AGPL | Copy or port when those adapters are built |
| Twenty | Lazy MCP tool surface, pausing tools for human approval, signed webhooks | n/a | Design reference |
| Jarvis | Mandate, rules, interrupt budget, observation pattern, event-log envelope, chunked-audio protocol, iOS shell and no-Mac build pipeline | Yours | Port |
| Handy | Tauri desktop app: hotkeys, audio capture, local engines (including Parakeet), paste on Windows | MIT | Fork |

## 10. Roadmap

Each milestone ends with something you use every day. Rough effort assumes you direct and
review while Claude Code writes most of the code; treat the estimates as order-of-magnitude.

| # | Milestone | Done means | Rough effort |
|---|---|---|---|
| M0 | **Foundations and Jarvis's spine**: monorepo, Postgres, the five core tables with server-side mention sync, action registry, passkey login, the web shell (split panes, hotkeys, Cmd+K and a UI kit; written fresh for M0, see D22), event stream, MCP server, Windows services, backups, CI. Plus the spine of section 6.1: event cursors, the reflex engine, the scheduler, approvals, the agent runtime, chat, @Jarvis replies, tasks assigned to Jarvis, and reflexes for notes and tasks | Create a note and a task, @link them, and see the link from both sides. Claude Code does the same over MCP. @Jarvis in a note gets an answer there, a task assigned to Jarvis gets worked, a task due tomorrow gets a warning. A backup restores cleanly in a test. | 3–4 weeks |
| B1 | **Jarvis's browser, step 1**: the Hearth extension in your own Chrome, a live view in Hearth you can click and type into, read-only browsing, page watches, and the untrusted-content rules (D24, D25) | Jarvis opens and reads pages in a Jarvis window of your Chrome while you watch from Hearth, a tab you hand it gets summarized, and a price watch tells you when it changes, without a model turn. Hearth opens Chrome when Jarvis needs it (D28). | 1–2 weeks |
| M1 | **Jarvis's day, tasks and calendar**: memory records, prep, brief, heartbeat and journal on the scheduler, Google Calendar two-way sync, tasks with time-blocking | A full workday runs on it: the brief arrives at 8:15 a.m., big tasks get calendar blocks, and nothing goes out in your name without a yes. The eval suite passes in CI. | 3–4 weeks |
| B2 | **Jarvis's browser, steps 2 and 3**: clicking, typing and submitting (each outward step waits for your yes), sign-ins from a vault without asking (D26), per-site memory and pacing, and browser routines on a schedule | Jarvis finishes a multi-site chore in your Chrome, signing in on its own and stopping for your yes before anything goes out. | 2–3 weeks |
| M2 | **Email**: the `MailProvider` interface with a Gmail adapter (both accounts), triage inbox, HTML rendering, attachments, drafts and send, people built from mail | One week of inbox zero on both Gmail accounts without opening Gmail. | 4–5 weeks |
| M3 | **Voice I**: Parakeet bake-off, Handy fork with dictation, cleanup, dictionary, snippets and history, plus voice chat with Jarvis | Parakeet (or whatever wins) measurably beats today's Whisper setup on your vocabulary. Median release-to-text under 1 second. A week of daily dictation. | 3–4 weeks; can run alongside M1 or M2 |
| M4 | **Docs**: Macro's Lexical and Loro packages, the sync room in `hearth-server`, @links, history, Jarvis as a co-editor; memory notes shown as docs | Your project notes live here, and Jarvis's edits show up live. | 4–6 weeks |
| M5 | **People and meetings**: person and organization pages, follow-ups, the meeting recorder, summaries linked to events and people | Tomorrow's prep packet includes notes from the last meeting with the same people, without you doing anything. | 3–4 weeks |
| M6 | **Phone**: polished PWA, then the iOS shell with widgets, Live Activity, share sheet and push-to-talk | You run your day from the phone when away from the PC. | 2–3 weeks |
| M7 | **Canvas (Macro's), Slack ingest, GitHub loop, Notion import**, spreadsheets, dictation command mode and styles, iOS keyboard, and Microsoft 365 or IMAP mail adapters when you add such an account | Ongoing | Ongoing |

M0 through M6 add up to roughly 21–30 weeks of steady work, plus 3–5 for the browser (B1, B2). Moving Jarvis's spine into M0 shifts
about a week from M1 to M0 without changing the total. The Macro mappers' independent
estimates for the same scope, using the borrowed packages, land in the same range. That's a long
road, which is why every milestone is useful on its own and M0–M2 come first.

## 11. Engineering standards ("up to standard")

These apply to the whole workspace, Jarvis included, and are enforced in CI:
- TypeScript strict mode and Rust clippy at deny-warnings.
- No source file over 400 lines, split by responsibility. Code copied from Macro is exempt until it is changed.
- Every action has a schema, a risk class and a test. Every migration is reversible.
- Unit tests for domain logic; integration tests against a real Postgres; Playwright tests for
  key UI flows (triage, @link, approve).
- Agent evals with recorded fixtures, which can block a merge.
- Logs and traces through OpenTelemetry to a local viewer, so `hearth doctor` can say why something
  is slow.
- Work happens on branches, you merge, and only you push, as Jarvis's rule already says.

## 12. Risks

| Risk | Mitigation |
|---|---|
| Scope: this is several products | Ship by milestone. Each one is useful alone. Don't start M4 until M0–M2 are in daily use. |
| One PC holds everything | Nightly offsite backups with automatic restore tests. Services restart themselves. `hearth doctor`. |
| Max rate limit shared with your own Claude Code use | Free watching, a daily turn budget, a small local model for dictation cleanup, and usage in the brief. |
| Google OAuth for personal apps | An unverified "Testing" app gets refresh tokens that expire after 7 days. Publish your OAuth app "In production" (unverified, used only by you) so tokens persist; you'll see a one-time warning screen. |
| GPU contention (8 GB VRAM) between speech and the cleanup model | Parakeet is small (0.6B parameters) and runs well on the CPU, so it can move off the GPU if the cleanup model needs the room. Measured in the bake-off. |
| Free Apple account: 7-day app signing | The PWA is the main phone surface. The iOS shell is re-signed weekly, as Remote-phone already does. |
| Borrowed AGPL code | Hearth is AGPLv3 itself (D19), every borrowed file keeps its notice, and `NOTICE.md` lists what came from where. Only matters if Hearth is ever shared or sold. |

## 13. Your answers (2026-10-01)

| Question | Answer | Where it landed |
|---|---|---|
| Cloud speech? | Keep cost at or near zero; prefer NVIDIA Parakeet. | Section 7.1, [D13](docs/decisions.md) |
| Drop the old Jarvis rules that don't fit? | Yes. | [research/jarvis.md](docs/research/jarvis.md#rules-dropped-for-the-new-workspace), [D14](docs/decisions.md) |
| More email accounts? | Not now, but other providers must be easy to add later. | Section 8.1, [D15](docs/decisions.md) |
| Offsite backup? | Use the Google One storage you already pay for. | Section 5.6, [D16](docs/decisions.md) |
| Name? | "Jarvis" stays the agent's name; the workspace gets a new one. | "Hearth", [D12](docs/decisions.md) |
| Jarvis's role? | Both reactive and proactive, for everything connected to Hearth. | Section 6.1, M0 in section 10, [D21](docs/decisions.md) |

Nothing is blocking M0. Decisions made since your answers, all from the Macro research:
- SolidJS instead of React, to reuse Macro's shell and editor ([D17](docs/decisions.md))
- Lexical and Loro for docs ([D18](docs/decisions.md))
- Hearth licensed AGPLv3 ([D19](docs/decisions.md))
- Macro's canvas instead of Excalidraw ([D20](docs/decisions.md))
