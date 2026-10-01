# Hearth

A personal, self-hosted workspace modeled on [Macro](https://macro.com), with Jarvis rebuilt as
its native agent. One graph of tasks, notes, people and conversations, one inbox, split panes,
and an agent that both answers you and acts on its own.

**Status:** M0 (foundations and Jarvis's spine) is built. See [PLAN.md](PLAN.md) for the roadmap.

- [docs/setup-windows.md](docs/setup-windows.md): install it on your PC
- [PLAN.md](PLAN.md): the plan
- [docs/decisions.md](docs/decisions.md): decisions and the alternatives considered
- [docs/research/](docs/research/): what we learned from Macro, Twenty and the old Jarvis

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

Tests need a Postgres role that can create databases; set `HEARTH_TEST_DATABASE_URL` if it isn't
`postgres://hearth:hearth@localhost:5432/postgres`.

## Layout

| Path | What |
| --- | --- |
| `packages/core` | Pure logic: mentions, filters, time and interrupt rules, conversation fold |
| `packages/db` | Schema, migrations, test databases |
| `packages/kernel` | Actions, policy, approvals, events, scheduler |
| `packages/modules` | Tasks, notes, inbox, chat, people, system, Jarvis's assistant module |
| `packages/jarvis` | Reflex engine, turn runner, brains, routines |
| `apps/server` | HTTP API, live events, passkeys, `/mcp` |
| `apps/worker` | Schedules and health checks |
| `apps/jarvis` | The Jarvis service |
| `apps/cli` | `hearth` command: setup, serve, backup, doctor, tokens |
| `apps/web` | The SolidJS web app |
| `ops/windows` | Windows services and the backup task |

Hearth is AGPLv3; it borrows from Macro (see [NOTICE.md](NOTICE.md)).
