# ReverseEngineer (Hearth)

> **A native Windows AI operating harness and tiling workspace with Claude (Jarvis v2) built in.**

ReverseEngineer (Hearth) is a personal, self-hosted desktop workspace and proactive agent system. It acts as both an intelligent **Windows window manager** and an **autonomous agent harness**, giving Claude a native place to live, observe, and proactively assist across your day-to-day workflow without needing to be prompted for every step.

Hearth is the direct evolution of **Remote-phone** (Jarvis v1)—moving from remote mobile automation to deep, native Windows desktop integration.

---

## Architecture & Core Capabilities

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Hearth Desktop Ecosystem                         │
│                                                                        │
│   ┌───────────────────────────┐      ┌─────────────────────────────┐   │
│   │   Native Windows WM       │      │   Dynamic Desktop Shell     │   │
│   │   (Rust / Tauri / Win32)  │◄────►│   (Dynamic Island, Pip,     │   │
│   │   • Niri-style Columns    │      │    Command Center, Voice)   │   │
│   │   • Hyprland-style Grid   │      │   SolidJS + Tailwind CSS    │   │
│   │   • Virtual Workspaces    │      └──────────────▲──────────────┘   │
│   └─────────────▲─────────────┘                     │                  │
└─────────────────┼───────────────────────────────────┼──────────────────┘
                  │                                   │ Live Events (WS/SSE)
                  ▼                                   ▼
   ┌─────────────────────────────────────────────────────────────────┐
   │                         Hearth Server                           │
   │      HTTP API • /mcp Bridge • Passkeys • Browser Bridge         │
   └──────────────▲───────────────────▲───────────────────▲──────────┘
                  │                   │                   │
                  ▼                   ▼                   ▼
     ┌────────────────────────┐  ┌──────────────┐  ┌──────────────────┐
     │  Jarvis Reflex Engine  │  │  PostgreSQL  │  │ Hearth Extension │
     │  Autonomous turns,     │  │  16+ Schema  │  │ Chrome browser   │
     │  routines & reflexes   │  │  & Migrations│  │ automation       │
     └────────────────────────┘  └──────────────┘  └──────────────────┘
```

### 1. Native Windows Tiling Window Manager (`apps/desktop`)
- **Tiling Modes**: Implements **Columns** (Niri-style scrolling window columns), **Grid** (Hyprland-style auto-tiling), and **Monocle** modes directly on Windows via native Win32 APIs in Rust.
- **Virtual Workspaces**: Full workspace management (Workspaces 1–4) with window enumeration, window snapping, focus switching, and multi-monitor work-area bounding.
- **Zero-Friction Hotkeys**: Background daemon with tray integration and instant summon via `Ctrl+Alt+H`.

### 2. Proactive AI Harness — Jarvis v2 (`packages/jarvis`)
- Unlike traditional reactive chat interfaces, Jarvis runs on an autonomous reflex engine that monitors your graph of tasks, notes, calendar, and email.
- Acts proactively on routine cadences, surfaces reminders, watches web pages for changes, and executes scheduled actions with permission-gated safeguards.
- Connects to external tools and models via the standard `/mcp` interface.

### 3. Integrated Workspace Graph (`packages/modules` & `apps/web`)
- Single unified graph connecting tasks, notes, contacts, and conversations with split-pane navigation.
- Browser automation companion (`apps/extension`) allowing Jarvis to inspect pages, read DOM states, and interact with web sessions safely.
- Built-in Voice Engine, Dynamic Island overlay, and Picture-in-Picture widgets for uninterrupted background assistance.

---

## Status & Milestones

Lean implementations of every milestone in [PLAN.md](PLAN.md) are built:

| Milestone | Built | On the PC |
| --- | --- | --- |
| **M0** Foundations & Jarvis's spine | Yes | Running |
| **B1** Jarvis browser: step 1 (read, watch, live view) | Yes | Pairs and connects |
| **M1** Jarvis day: tasks, routines, and calendar | Yes | Calendar sync running |
| **B2** Browser: steps 2 & 3 (click, type, submit) | Yes | Built and tested |
| **M2** Email (multi-account Gmail sync) | Yes | Running |
| **M3** Voice & Desktop (dictation, voice engine, WM) | Yes | Hearth for Windows running (`Ctrl+Alt+H`) |
| **M4** Docs (live notes & graph references) | Yes | Running |
| **M5** People & Meetings | Yes | People module running |
| **M6** Mobile/Phone companion (PWA & push) | Yes | Push notifications active |
| **M7** Canvas, sheets, Notion import, GitHub | Yes | Canvas & imports running |

- [docs/setup-windows.md](docs/setup-windows.md): In-depth Windows installation guide
- [PLAN.md](PLAN.md): Technical roadmap and architectural milestones
- [docs/decisions.md](docs/decisions.md): Architecture Decision Records (ADRs)
- [docs/research/](docs/research/): Benchmarks and research from Macro, Twenty, and Jarvis v1

---

## Updating Hearth

From a standard (non-elevated) PowerShell window in the repository root:

```powershell
.\ops\windows\update.ps1
```

This takes an automated database safety dump, pulls the target deploy commit, builds packages, runs migrations, restarts services, and monitors health for 3 minutes before finalizing (or automatically rolling back on failure).

---

## Developer Setup

### Prerequisites
- **Node.js**: `v22.18+` (Node 24 recommended)
- **pnpm**: `pnpm v9+`
- **PostgreSQL**: `16+` (running locally or accessible via network)
- **Rust toolchain**: (optional, only required if compiling the desktop Tauri app)

### Quickstart

```sh
# 1. Install workspace dependencies
pnpm install

# 2. Configure environment
cp .env.example .env
# Set HEARTH_DATABASE_URL in .env to your Postgres instance

# 3. Run database migrations & generate initial admin passkey
pnpm hearth setup

# 4. Start the backend stack (HTTP server, background worker, Jarvis engine on :4400)
pnpm dev

# 5. In a second terminal, launch the web client with hot-reload (:5173)
pnpm --filter @hearth/web dev

# 6. Typecheck and run tests
pnpm check
```

### Running the Desktop App
```sh
cd apps/desktop
pnpm tauri dev
```

### Running Test Suites
Tests use a dedicated template database to guarantee isolation:

```powershell
# Setup isolated test database on Windows
$bin = "C:\Program Files\PostgreSQL\17\bin"; $dir = "$env:LOCALAPPDATA\HearthTestDb"
& "$bin\initdb.exe" -D $dir -U hearth --auth=trust
Add-Content "$dir\postgresql.conf" "listen_addresses = 'localhost'`nport = 5499`nfsync = off"
& "$bin\pg_ctl.exe" -D $dir -l "$dir\server.log" start *> $null
$env:HEARTH_TEST_DATABASE_URL = "postgres://hearth@localhost:5499/postgres"

# Execute test suite
pnpm test
```

---

## Monorepo Layout

| Path | Purpose |
| --- | --- |
| `apps/desktop` | Tauri v2 desktop application, Win32 window manager (`wm.rs`), global hotkeys |
| `apps/web` | SolidJS dynamic workspace UI, Dynamic Island, Pip, CommandCenter |
| `apps/server` | Express / Node HTTP API, WebSocket live events, `/mcp` gateway |
| `apps/worker` | Background task schedules, health monitors, page watch recurring jobs |
| `apps/jarvis` | The Jarvis background runner and autonomous routine worker |
| `apps/extension` | Chrome extension providing the secure browser-driving companion |
| `apps/cli` | `hearth` CLI (`setup`, `serve`, `doctor`, `backup`, `restore`) |
| `packages/jarvis` | Core reflex loop engine, turn evaluator, memory state |
| `packages/modules` | Tasks, notes, inbox, calendar, people, and system modules |
| `packages/kernel` | Security policy, action permissions, scheduler, approvals |
| `packages/db` | Prisma/Kysely schemas, migrations, test database fixtures |
| `packages/core` | Shared domain primitives, filters, mention parsing, date arithmetic |

---

## License & Attribution

Hearth is licensed under the **MIT License**. Portions of the workspace UI paradigms are modeled on Macro (see [NOTICE.md](NOTICE.md)).
