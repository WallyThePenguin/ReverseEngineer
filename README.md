# Hearth

A personal, self-hosted workspace with its own agent. One graph of tasks, notes, people and
conversations, one inbox, split panes, and an agent that both answers you and acts on its own.

You see it as **Nook**, and its agent as **Pip** (D74); the code, services and data keep the names
Hearth and Jarvis. Nook's look is the design system in [design/nook/](design/nook/README.md).

## Status

Lean versions of every milestone in [PLAN.md](PLAN.md) are built. The work now is making them
dependable on the PC, reliability first (D57 is the deploy side). As of 2026-10-05:

| Milestone | Built | On the PC |
| --- | --- | --- |
| M0 Foundations and Jarvis's spine | Yes | Running |
| B1 Jarvis's browser, step 1 (read, watch, live view) | Yes | Pairs and connects; Jarvis hasn't driven a page live yet |
| M1 Jarvis's day, tasks and calendar | Yes | Calendar sync running; Jarvis's turns failed from 2026-10-03 until #26 |
| B2 Browser, steps 2 and 3 (click, type, submit, sign-ins) | Yes, narrower than Claude in Chrome | Not used live yet |
| M2 Email (Gmail, both accounts) | Yes | Running |
| M3 Voice (dictation, voice chat) | Yes, in the desktop app (D43) | Hearth for Windows 1.0.19 installed (`D:\HearthDesktop\hearth.exe`); starts hidden with Windows, `Ctrl+Alt+H` opens it |
| M4 Docs (live notes, D38, not Macro's editor) | Yes | Running |
| M5 People and meetings | Yes | People running; meeting recorder not installed |
| M6 Phone (installed web app, push) | Yes | Notifications are turned on per device in Settings → Phone |
| M7 Canvas, sheets, Notion import, Slack, GitHub | Yes | Canvas, sheets and import running; Slack and GitHub not connected |

- [docs/setup-windows.md](docs/setup-windows.md): install it on your PC
- [PLAN.md](PLAN.md): the plan
- [docs/decisions.md](docs/decisions.md): decisions and the alternatives considered
- [docs/research/](docs/research/): what we learned from Macro, Twenty, the old Jarvis and Polar

## Updating Hearth

On the PC, from a normal (not elevated) PowerShell in the Hearth folder:

```powershell
.\ops\windows\update.ps1
```

It takes a safety dump, moves to the latest commit of the deploy branch, builds, migrates and
restarts, then gives the new version three minutes to prove itself (the right commit, every
migration, the worker and Jarvis reporting in, no new `hearth doctor` failures) or puts the
previous version back. See "Updating Hearth" in [docs/setup-windows.md](docs/setup-windows.md)
for the details, and `pnpm hearth restart` and `pnpm hearth restore` for the rest.

## Develop

Needs Node 22.18+ (24 recommended), pnpm and PostgreSQL 16+.

```sh
pnpm install
cp .env.example .env        # set HEARTH_DATABASE_URL
pnpm hearth setup           # migrate, and print a code for your first passkey
pnpm dev                    # server, worker and Jarvis on :4400
pnpm --filter @hearth/web dev   # the web app with hot reload on :5173
pnpm check                  # lint, typecheck, file sizes, tests
```

The browser's end-to-end check loads the extension into Chromium against a server with
development login on (see the top of `apps/web/e2e/browser.ts`):

```sh
HEARTH_DEV_AUTH=1 HEARTH_WEB_DIST=apps/web/dist pnpm hearth serve
pnpm --filter @hearth/web e2e:browser
```

A second check has the server open Chromium by itself, the way it opens your Chrome (Linux; see
the top of `apps/web/e2e/chrome-launch.ts`). Two more check that the app rides through Hearth
being down: `e2e:resilience` fakes errors and timeouts against a running server, and
`e2e:offline` starts and stops its own to check the service worker (see the top of each file).

Tests need a Postgres role that can create databases, named by `HEARTH_TEST_DATABASE_URL` (for
example `postgres://hearth:hearth@localhost:5432/postgres` on a PC that doesn't run Hearth). There's
no default, so a test run can't land on the cluster holding your data. On a PC that also runs
Hearth, give tests a cluster of their own:

```powershell
$bin = "C:\Program Files\PostgreSQL\17\bin"; $dir = "$env:LOCALAPPDATA\HearthTestDb"
& "$bin\initdb.exe" -D $dir -U hearth --auth=trust
Add-Content "$dir\postgresql.conf" "listen_addresses = 'localhost'`nport = 5499`nfsync = off"
& "$bin\pg_ctl.exe" -D $dir -l "$dir\server.log" start *> $null
$env:HEARTH_TEST_DATABASE_URL = "postgres://hearth@localhost:5499/postgres"
```

Each checkout gets its own template database, so test runs in two worktrees don't collide.

Timed tests (a 3,000-cell sheet worked out in under 100 ms, say) have budgets for a developer's PC.
On a slower machine, set `HEARTH_PERF_SLACK` to how many times slower it is: CI sets 2 on Linux and
3 on Windows (see `packages/db/src/testing/timing.ts`).

## Layout

| Path | What |
| --- | --- |
| `packages/core` | Pure logic: mentions, filters, time and interrupt rules, conversation fold |
| `packages/db` | Schema, migrations, test databases |
| `packages/kernel` | Actions, policy, approvals, events, scheduler |
| `packages/modules` | Tasks, notes, inbox, chat, people, system, the browser and page watches, Jarvis's assistant module |
| `packages/jarvis` | Reflex engine, turn runner, brains, routines |
| `apps/server` | HTTP API, live events, passkeys, `/mcp`, the browser bridge and live view |
| `apps/worker` | Schedules, page watch checks and health checks |
| `apps/jarvis` | The Jarvis service |
| `apps/cli` | `hearth` command: setup, serve, backup, restore, restart, doctor, tokens |
| `apps/web` | The SolidJS web app, and its end-to-end checks (`e2e/`) |
| `apps/extension` | The Hearth extension for Chrome (Jarvis's browser) |
| `ops/windows` | Windows services and tasks, updates (`update.ps1`) and restarts |

Hearth is MIT-licensed; what it copies from other projects, and their licenses, is in
[NOTICE.md](NOTICE.md).
