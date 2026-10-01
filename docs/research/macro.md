# Research: Macro (macro.com)

Status: pending. The subsystem map (link graph, email and CRM, docs and sync, tasks, AI and
memory, search and files, frontend) is still running; this note will be filled in from it.

What is already known, from a first pass over `macro-inc/macro` (cloned 2026-10-01, version
v2026.4.28.0):

- License: AGPLv3, "fully open source, not open core".
- Size: about 1.1M lines of Rust and 1.3M lines of TypeScript/TSX (including some generated code),
  ~50 deployable services, 221 Rust crates, 8 shared TypeScript packages, past 7,000 merged PRs.
- Stack: Rust services in a hexagonal layout, a SolidJS frontend (web, Tauri desktop, iOS), and
  Pulumi on AWS. The local stack runs ~25 app containers plus Postgres (pgvector), Redis, Kafka and
  OpenSearch. Docs sync runs on Cloudflare Workers and Durable Objects with the Loro CRDT.
- Production depends on AWS Lambda, SQS, SNS, S3 and SES, plus FusionAuth, Doppler and Datadog.
- Email: Gmail only. No IMAP or Microsoft mail adapter was found.
