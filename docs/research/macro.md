# Research: Macro (macro.com)

Source: `macro-inc/macro`, cloned 2026-10-01 (version v2026.4.28.0, last commit that morning).
Seven subsystems were mapped in depth: the link graph and inbox, email and CRM, docs and sync,
tasks, AI and memory, search, files and calls, and the frontend. Team chat internals and
multi-tenant infrastructure were skipped as out of scope for one user.

**Verdict: copy the ideas, lift a handful of self-contained packages, rebuild everything else.**
Macro's product design is excellent, and several of its packages are self-contained enough to
lift. But its services are tightly wired to each other, to multi-tenant permissions, and to AWS,
Kafka and Cloudflare. For example, `services/email_service` has 53 internal path dependencies,
and tasks can't be separated from the document stack. The mappers independently estimated a
lean rebuild of each part at a few weeks, against hundreds of thousands of lines in Macro.

## At a glance

| | |
|---|---|
| License | AGPLv3, "fully open source, not open core" |
| Size | About 1.1M lines of Rust and 1.3M of TypeScript (including tests and generated code). ~50 services, 221 crates, 8 shared packages, and the web app alone is about 565K handwritten lines. |
| Backend | Rust services in a hexagonal layout; Postgres (408 migrations), Redis, Kafka and AWS-managed OpenSearch; AWS Lambda, SQS, SNS, S3, SES and DynamoDB; FusionAuth, Doppler and Datadog; Pulumi for infrastructure |
| Docs sync | Cloudflare Workers and Durable Objects, with the Loro CRDT |
| Frontend | One SolidJS + Vite + Tailwind v4 app for web, Tauri desktop and Tauri mobile |
| Email | Gmail only. A provider-neutral interface exists, but only a Gmail adapter implements it. |
| Search | Keyword only, with no semantic search, on OpenSearch |
| Calls | LiveKit Cloud, Deepgram transcription and Claude summaries |
| AI | A Rust agent loop over Anthropic, OpenAI, Gemini and others, about 95 hand-written tools, and API-key billing |

## 1. The graph, the inbox and the feed ("soup")

**How it works.** There's no single objects table. Every object is addressed by an
`(entity_type, entity_id)` pair, and cross-cutting features hang off polymorphic side tables:
- links: `comms_entity_mentions`
- custom fields: `entity_properties`
- the inbox: `user_notification`
- favorites, frecency and activity

"Soup", the unified feed, is a Postgres UNION over documents, chats, projects and events, plus
parallel calls to the email, channel, call and CRM services, merged and paginated by keyset.

**What we take:**
- **A real `entity` table** plus one `link` table, polymorphic on both ends and indexed both
  ways. Backlinks become one query. (Macro's own mapper recommends this as the first change in
  any fork.)
- **Inline mention tags in markdown** (`<m-document-mention>{json}</m-document-mention>`, parsed in
  `crates/mention_utils`). Content stays portable, and links stay machine-readable. Jarvis can
  write a mention directly in markdown.
- **Server-side mention sync.** On every save, from the UI, Jarvis or an importer, parse the
  content, diff it against existing links and upsert them in the same transaction. Macro relies
  on the web editor to report each mention. Edits by AI, other clients or imports never update
  backlinks, and there's no uniqueness constraint. We fix that.
- **An inbox built from notifications**, not unread flags. Each event writes a notification with
  the state unseen, seen or done, plus snooze. The inbox shows the latest live notification per
  item (`crates/notification_state`).
- **Signal and Noise** as a cheap flag: Gmail's category labels, overridden by per-sender and
  per-domain rules. "Mark sender as noise" is a one-click training signal (the `email_filters`
  table).
- **One filter language** (`crates/filter_ast`, 142 lines, with And/Or/Not and typed literals),
  shared by the UI, saved views and the agent's tools.
- **Keyset pagination** on `(sort_ts, id)` with an opaque cursor, sorted by updated, created,
  viewed, frecency or "touched by me".
- **Frecency:** +2 for an open, -1 for a close, the last 10 events with hourly exponential decay,
  then `0.7*log2(count+2) + 0.3*recency` (`crates/frecency`).
- **An append-only activity log** with idempotent IDs.
- **Custom properties:** definitions, options and typed JSONB values, with entity-reference
  values acting as relations and system properties seeded at fixed UUIDs (migrations
  `20251030100000`, `20251128000001`).
- **Realtime pushes only identity** ("entity X updated"); the client refetches.

**What we leave:** the ACL engine (`entity_access`, 28K lines), share permissions, channel-based
permissions, team scoping, Kafka, the GraphQL layer, and the Rust/WASM client cache. One user
sees everything they own.

## 2. Email, CRM and calendar

**How it works.** Gmail sends a Pub/Sub push, the change goes onto SQS, `history.list` produces a
change set, and each changed message becomes its own job. User actions are written to the
database first, then sent to Gmail through a retry queue that reverts on permanent failure. The
CRM builds itself from email. Calendar mirrors Google with sync tokens and push channels.

**What we take:**
- **The provider interface:** sync, subscription, messages, send, labels and attachments, with
  an opaque sync cursor and change batch (`crates/email_api_client/src/domain/`). It's our
  `MailProvider`, with room for IMAP and Microsoft Graph from day one.
- **Cursor-based incremental sync.** An expired cursor triggers a backfill, and the cursor is
  repaired so the loop can't repeat forever.
- **Local first:** apply the change locally and show it immediately, send it to the provider in
  the background, and roll back on a permanent error.
- **Threading by RFC headers** (Message-ID, In-Reply-To, References), not the provider's thread ID.
- **CRM rules:**
  - Only mail you send creates a company or contact; received mail only updates ones already
    tracked.
  - Role accounts, free-mail domains and your own domain are skipped.
  - Interaction date ranges merge (`crates/crm/src/domain/companies_repo.rs`).
- **A domain enrichment cache with negative entries**, so each domain is looked up once.
- **The calendar model:** one canonical event, its provider sources, per-occurrence overrides, and
  a materialized occurrence table indexed with GiST range types for fast agendas.
- **Reminders as a rebuildable schedule plus exactly-once delivery claims**, so a moved event
  fires again but a sent alarm is never resurrected.
- **Calendar invitations** parsed once into immutable snapshots and matched to the live event for
  RSVP (`calendar_invitation_parser.rs`).
- **Agent send safety:** the agent's send tool returns a draft; actually sending needs your quoted
  approval, and the MCP host doesn't expose send at all.
- **Echo suppression:** events are tagged with their origin (your action or provider sync), so
  automation ignores its own echoes.
- **`packages/email-renderer`:** a framework-free email body renderer with quote and signature
  folding and color adaptation. Lifted as-is.

**What we change:**
- Poll `history.list` every 30–60 seconds instead of Pub/Sub, so no inbound endpoint is needed.
- Store raw MIME on disk, content-addressed, so messages can be re-parsed later.
- Make deals their own table rather than a stage property on a company.
- Merge Contacts and CRM contacts into one `person` table keyed by email address.
- Use Postgres full-text search instead of OpenSearch.

**What we leave:** SES suppression, cal.com, Apollo.io enrichment, delegation, quota limiters,
outboxes and the connection gateway.

## 3. Docs, real-time sync and canvas

**How it works.** A "markdown" doc is actually a Loro CRDT whose shape mirrors Lexical's editor
tree. Each block has a durable ID, which also anchors search hits, comments and AI edits; markdown
is only an import and export format.

Each document gets a single-writer "room" (a Cloudflare Durable Object). On every update the room:
1. imports the change
2. persists the op
3. acknowledges it
4. broadcasts it to the other clients

It compacts to snapshots every 5 seconds.

Clients work offline with an IndexedDB write-ahead log, catch up by version vector, and share
state between tabs. History is Loro time-travel, with no extra storage. The AI editing worker
joins a doc as a real CRDT peer with its own cursor and applies a small, deterministic set of
operations. The canvas is a separate SolidJS editor that saves one JSON blob, last write wins.

**What we take (code, AGPL):**
- `packages/lexical-core` (20K lines): Lexical nodes including mentions, the markdown transforms,
  and the Loro schema. It imports only `lexical`.
- `packages/collaboration` (11K lines): the Loro manager, write-ahead log and websocket
  transport. Its URL and token are injected, and its storage is pluggable.
- `packages/loro-mirror`: a vendored fork of an MIT library.
- The web editor and its collaboration binding (SolidJS).
- The **sync protocol**: a 57-line Bebop schema with 5 client and 6 server messages. Keeping it
  means the client packages work unchanged.
- From `services/ai-editing-worker`: the deterministic editing parts (`editor/`, `doc/`,
  `awareness/`), which become Jarvis's doc tools. The model chains are dropped, because they need
  API keys.
- `packages/spreadsheet` (IronCalc) for later.
- `apps/web/src/features/block-canvas` (14.6K lines; only 5 outside files import it): the canvas
  with @linked cards.

**What we change:**
- The room server is re-hosted from Cloudflare into `hearth-server` (TypeScript with the Loro JS
  engine), speaking the same Bebop protocol and storing snapshots and ops in Postgres. The
  mapper estimated 1.5–2.5K lines.
- Mention links are derived on the server from the CRDT on every persist (see section 1).
- History gets restore-in-place and named checkpoints.
- Macro's all-ops log is never pruned, so storage grows forever. Ours compacts.

**What we leave:** Cloudflare D1, KV and R2, the document storage service (14.5K lines, replaced
by a few routes), the Rust `crates/documents` (30.6K lines, entangled with tasks, GitHub and
teams), LibreOfficeKit (replaced by a `soffice --headless` subprocess when needed), and the
QuickJS sandbox.

## 4. Tasks, projects and scheduling

**How it works.** A task is a markdown document with a "task" subtype. Its status, assignees,
priority and due date are property rows. Projects ("initiatives") group tasks.

GitHub PRs are matched to tasks by an ID in the title, body or branch:
- The PR is linked to the task, and the PR gets a backlink comment.
- The task moves to In Review when the PR opens, Completed when it merges, and back to Not
  Started when it closes unmerged.

Work goes to coding agents either through a prompt template and deep links, or through an
agent-session platform.

**What we take:**
- **A task has a doc body**, so it gets the editor, mentions, comments and search for free. Core
  fields (status, priority, due, parent, project) are typed columns, and custom fields use
  properties.
- **The status vocabulary:** Not Started, In Progress, In Review, Completed, Canceled. Priority
  runs Low to Urgent. Seeded at fixed IDs.
- **Short task IDs** (T-123) and **deterministic branch names**
  (`crates/documents/src/domain/branch_name.rs`), plus **the PR-to-task loop**, which only moves
  status forward and never overrides Completed or Canceled.
- **The coding-agent handoff prompt** (`generateTaskPrompt` in `DispatchAgentMenu.tsx`): task,
  branch, comment history and conventions. Jarvis runs it in a git worktree and records the run
  on the task.
- **Create a task from anything,** pre-filled with a mention of its source.
- **One scheduler:**
  - one-shot or cron+timezone schedules with a precomputed `next_run_at`
  - idempotent claims with UNIQUE (schedule, scheduled_for)
  - a staleness rule that skips a missed firing once the next one is due (`is_stale_firing`)
  - event-filtered routines

  Macro has three separate schedulers; we merge them.

**What we leave:** Cursor, Codex and Claude cloud agent providers, sandboxes, and task
deduplication. The "Claude Cloud" integration relies on an unofficial subscription protocol
(`docs/CLAUDE_CLOUD_DEMO.md`). Don't copy it: running the official Agent SDK locally is the safe
way to use a Max subscription.

## 5. AI, memory and tools

**How it works.** A Rust agent loop routes to several model providers and runs about 95
hand-written tools from one registry. Each tool is tagged read-only, additive or destructive and
assembled per host (chat, agent, bot, MCP). Outbound actions (send email, create a calendar event)
return a pending execution the user reviews.

"Team memory" is one markdown row per user, regenerated lazily when it's more than 24 hours old:
1. An Opus agent researches the user's data with tools.
2. A Sonnet judge accepts or rejects the result.
3. The result is injected into prompts as `<user_memory>` data.

**What we take:**
- **One typed tool registry for every host,** with a mandatory risk annotation. This is our
  action registry.
- **Pending-execution tools** for anything outbound, which is our approval inbox.
- **The memory loop:** research with tools, output inside `<memory>` tags, an optional judge, and
  injection last as data. Our version runs nightly with a lock and keeps versions. Macro's has no
  in-flight dedupe and no backoff, so every read of a stale memory starts another research run.
- **AI projections:** cached, schema-constrained agent outputs keyed by prompt hash, with a stale
  time. Ideal for the morning brief, "needs reply" and similar widgets (`crates/ai_projections`).
- **Automations as data:** a trigger (cron or event filter), a prompt and a target; each run is
  saved as a conversation.
- **Agent sessions as an append-only log plus a pure fold,** so live streaming and reloading render
  the same way (`crates/agent_fold`).
- **Prompt text** (`crates/prompt`, about 1.1K lines, including the mention grammar), the memory
  and judge prompts, the system skills ("Catch me up", "What I did yesterday") and
  `crates/ai_toolset/TOOL_DESIGN.md`.
- **The 92-page MCP tool reference** (`apps/docs/AI/mcp/tools`), as a checklist.

**What we leave:** the multi-provider router, the agent-session platform (about 120K lines), ACP
sandboxes, billing and usage journals, Pipedream, the MCP auth proxy, and the Claude Cloud
harness.

## 6. Search, files and calls

**How it works.**
- **Search** is keyword-only on OpenSearch. Each entity is a parent document with content-chunk
  children (a PDF page, a doc block, a transcript segment), so a hit opens at the exact spot.
  Indexing treats every change event as "reread": the worker reloads the source and overwrites
  the index entries.
- **Files** live in S3 and CloudFront.
- **Calls** run on LiveKit Cloud, with Deepgram transcription per participant and Claude summaries.

**What we take:**
- **The index as a projection:** "something changed" means reread and fully replace, so replays
  and out-of-order delivery are safe.
- **Parent/child chunks with jump targets.** Each search term must match some chunk of the same
  entity, so multi-word queries work across pages.
- **One result shape** for every type: type, id, highlighted title and snippets, jump target.
- **PDF citation extraction** (`extract_text_citations.rs`, about 250 lines): stable chunk IDs with
  page rectangles, so Jarvis can cite and the UI can highlight.
- **The call pipeline:**
  - one transcription stream per participant
  - deterministic segment IDs
  - timestamps anchored to the true audio start
  - an async summary, title and speaker attribution

**What we change:** hybrid search in Postgres. Full-text, trigram matching on titles, and
embedding similarity are fused with reciprocal-rank fusion, with recency as a boost rather than
the only sort. Embeddings come from a local model. Files go on local disk, content-addressed. Calls
are recorded locally rather than hosted.

## 7. Frontend

**How it works.** One SolidJS app runs on the web, on Tauri desktop and on mobile:
- **Shell:** a keyboard-first tiling window manager. A typed split-pane router (`src/lib/split-router`)
  can show any entity or view in any pane, encoded in one URL.
- **Commands:** a scoped hotkey engine where commands are data, which drives shortcuts, leader
  keys (`c` create, `g` go-to) and the Cmd+K palette.
- **Data:** TanStack Query over generated REST clients, urql GraphQL for the feed, and one
  websocket of typed patch and invalidate events.
- **Theming:** semantic OKLCH color tokens, so no component uses raw palette colors.

**What we take (code, AGPL):**
- `src/lib/split-router` (4.7K lines, no app imports)
- `packages/machine` (1K lines)
- the hotkey engine `src/lib/core/hotkey` (2.8K lines; a few imports to shim)
- the Cmd+K design (`useCommandItems.ts`): commands in scope, plus a local recency index, plus
  "search" and "ask Jarvis" fallbacks
- the UI primitives in `src/components/ui` (on Kobalte), the token scheme in `src/index.css`, and
  one or two theme files, recolored to your dark-blue palette
- the entity and property slot components, as a pattern
- the realtime pattern from `SyncProvider.tsx`: one stream, typed events mapped to cache updates

**What we leave:** the rest of the app (about 565K lines wired to 17 backend services), Orval and
GraphQL codegen, urql, the Turso/WASM cache, PostHog, Datadog and the custom Tauri forks.

**Why this changed the UI framework choice:** these pieces are SolidJS. Using them means Hearth's
web UI is SolidJS too (decision D17).

## Macro weaknesses Hearth fixes

| Macro | Hearth |
|---|---|
| Gmail only | `MailProvider` interface, with IMAP and Microsoft Graph as later adapters |
| Mention links drift when content changes outside the web editor | Links derived on the server from content on every save |
| Keyword-only search | Hybrid full-text and semantic search, run locally |
| Memory regeneration has no dedupe or backoff | Nightly job with a lock and versioned memory |
| Three separate schedulers | One scheduler |
| The docs op log is never pruned | Compaction |
| The canvas is last-writer-wins JSON | Acceptable for one user at first; can move to Loro later |
| The AI editing pipeline needs API keys | Jarvis on the Agent SDK, using your Max login |
| Overlapping data-fetching stacks in the frontend | One typed API, one query cache, one event stream |
| Self-hosting needs AWS, Cloudflare and about 25 containers | One PC, native services, Postgres |
