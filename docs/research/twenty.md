# Research: Twenty (twenty.com)

Source: `twentyhq/twenty` at commit `daf0b2a` (2026-10-01, SDK v2.45). Read on 2026-10-01.

**Verdict: a strong CRM, a poor backbone for a personal workspace. We don't run it; we borrow
from it.** Twenty is a well-built, actively developed open-source CRM. It would be a fine
contacts-and-deals module, but in a one-person workspace that also owns email, calendar and a
link graph, running it means two systems of record for the same people, a second UI, and a
2–3 GB TypeScript stack for what is a modest part of the product.

## Facts that matter

| Question | Answer |
|---|---|
| License | Mostly AGPLv3, with an "Application Exception": apps that only talk to Twenty through its APIs or SDK can use any license. 452 files (~40k lines: billing, SSO, row-level permissions, record sharing, audit logs) are under a commercial Enterprise license. The SDK, UI kit and example apps are MIT. Search results claiming Twenty is MIT are wrong. |
| Size | About 1.07M lines in the server and 690k in the frontend (TypeScript, NestJS and React). |
| Self-hosting | Four containers: server, worker, Postgres 16, Redis. About 2–3 GB RAM. Runs on Windows only through Docker Desktop and WSL2. Migrates its database on every boot; releases are frequent, so you pin a version. |
| Data model | Real runtime custom objects and fields: each becomes a Postgres table and immediately gets GraphQL, REST, OpenAPI and MCP access. |
| Linking | No bidirectional @links. Mentions in rich text are display chips the server never indexes; there's no "referenced by" panel. Any-to-any links exist only as one foreign-key column per target type. |
| Email | Syncs Gmail (API), Microsoft 365 (Graph) and plain IMAP/SMTP, but it's a CRM capture layer, not a mail client: no inbox, no read/unread, archive, labels or snooze, plain-text bodies only, inbound attachments discarded, and newsletters, notifications and calendar invites filtered out by default. |
| Calendar | Google, Microsoft and CalDAV import, plus event creation. No edit, delete or RSVP. |
| AI | Side-panel chat, database-defined agents and skills, a working MCP server, and a workflow engine with 4 trigger types and 20 actions. No long-term memory and no semantic (embedding) search. |
| Custom UI | Possible without forking only through "front components", which are beta and run in a sandbox with a partial DOM (no canvas, portals or ResizeObserver). Anything like a doc editor, canvas or chat UI would have to live outside Twenty. |
| Meetings | The companion recorder is an unsigned macOS Apple-Silicon dev build that records through Recall.ai's cloud. It won't run on your Windows PC, and it sends audio to the cloud. |

## How we use Twenty

We don't install it. We take ideas and, where the license fits, code.

**Free to reuse (MIT):**
- `packages/twenty-shared/src/types`: the field-type catalog and view/filter models, a good
  reference for our own properties and saved views.
- `packages/twenty-shared/src/utils/tiptap`: rich-text JSON to markdown converters.
- `packages/twenty-sdk/.../ingest-message.type.ts`: a clean schema for ingesting email and chat
  threads from any channel.
- `packages/twenty-apps/public/{granola,fireflies,fathom,teams,slack}`: working importers to copy
  patterns from.

**Reusable under AGPL (fine for private, single-user use; see the license note in the plan):**
- The IMAP driver with UIDVALIDITY and CONDSTORE cursors, and Sent/Drafts folder detection
  (`modules/messaging/message-import-manager/drivers/imap/`).
- Quoted-history stripping and body normalization (`.../utils/extract-message-text-without-quoted-history.util.ts`).
- Contact heuristics: names from display names, company from domain, free-mail and group-address
  detection (`contact-creation-manager/utils/`, `src/utils/email-providers.ts`, `is-group-email.ts`).
- CalDAV import through `tsdav` with sync tokens (`calendar/.../drivers/caldav/`).
- Gmail Pub/Sub and Microsoft Graph webhook handling with subscription renewal.
- Outbound threading headers for replies.

**Design ideas to copy, not code:**
- Metadata-generated agent tools: per-object find/create/update/delete tools with JSON schemas
  built from the field definitions. Our action registry does the same thing from one source.
- The lazy MCP surface (`get_tool_catalog`, `learn_tools`, `execute_tool`), which keeps a large
  tool set from flooding the model's context.
- "Pausing tools" for human-in-the-loop agents (`ask_questions`, `request_form`, `propose_email`):
  the same shape as our approval inbox.
- HMAC-signed webhooks over `timestamp:body`.
- Its skill prompts (meeting prep, CRM hygiene, enrichment) as inspiration for the agent's skills.

**Avoid:** every file headed `/* @license Enterprise */`.

## If you later want Twenty anyway

Nothing in the plan blocks running Twenty next to the workspace as a CRM. The agent could talk to
its MCP server with a role-scoped API key, and the Application Exception keeps the workspace's
license independent. For personal use, set contact auto-creation to "sent and received", turn off
"exclude non-professional emails" (or friends on gmail.com never become contacts), disable
telemetry, and allowlist the workspace host in `OUTBOUND_HTTP_ALLOWED_INTERNAL_HOSTS` so its
webhooks can reach it.
