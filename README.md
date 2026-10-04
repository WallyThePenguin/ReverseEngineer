# Hearth

A personal, self-hosted workspace modeled on [Macro](https://macro.com), with Jarvis rebuilt as
its native agent. One graph of tasks, notes, people and conversations, one inbox, split panes,
and an agent that both answers you and acts on its own.

**Status:** M0 (foundations and Jarvis's spine) and step 1 of Jarvis's browser (B1) are built:
Jarvis browses in your own Chrome while you watch, and take over, inside Hearth, and Hearth
opens Chrome when Jarvis needs it. See
[PLAN.md](PLAN.md) for the roadmap.

- [docs/setup-windows.md](docs/setup-windows.md): install it on your PC
- [PLAN.md](PLAN.md): the plan
- [docs/decisions.md](docs/decisions.md): decisions and the alternatives considered
- [docs/research/](docs/research/): what we learned from Macro, Twenty, the old Jarvis and Polar

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

Tests need a Postgres role that can create databases; set `HEARTH_TEST_DATABASE_URL` if it isn't
`postgres://hearth:hearth@localhost:5432/postgres`. On a PC that also runs Hearth, give tests a
cluster of their own instead of the one holding your data:

```powershell
$bin = "C:\Program Files\PostgreSQL\17\bin"; $dir = "$env:LOCALAPPDATA\HearthTestDb"
& "$bin\initdb.exe" -D $dir -U hearth --auth=trust
Add-Content "$dir\postgresql.conf" "listen_addresses = 'localhost'`nport = 5499`nfsync = off"
& "$bin\pg_ctl.exe" -D $dir -l "$dir\server.log" start *> $null
$env:HEARTH_TEST_DATABASE_URL = "postgres://hearth@localhost:5499/postgres"
```

Each checkout gets its own template database, so test runs in two worktrees don't collide.

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
| `apps/cli` | `hearth` command: setup, serve, backup, doctor, tokens |
| `apps/web` | The SolidJS web app, and its end-to-end checks (`e2e/`) |
| `apps/extension` | The Hearth extension for Chrome (Jarvis's browser) |
| `ops/windows` | Windows services and the backup task |

Hearth is AGPLv3; it borrows from Macro (see [NOTICE.md](NOTICE.md)).
