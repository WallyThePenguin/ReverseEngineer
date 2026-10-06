# CI

Every push to the deploy branch, every pull request and every manual run goes through
`.github/workflows/ci.yml`: lint, types, the file size limit, the tests, the web build and its
bundle size, a real server start checked through deep health and the doctor, the browser
end-to-end suites, and a backup restored into a fresh database. It runs on your PC, next to the
live Hearth, fenced off from it (D66).

## Where it runs

| Job | Runner | Labels | What it is |
| --- | --- | --- | --- |
| `check` | `hearth-pc-linux` | self-hosted, Linux, X64, hearth-ci | A Docker Desktop container from `ops/ci-runner/linux`, with PostgreSQL 16 and Chromium's libraries |
| `windows` | `hearth-pc-win` | self-hosted, Windows, X64, hearth-ci | GitHub's runner in `D:\hearth-ci\runner-win`, as you, unelevated, at below-normal priority |
| `windows` in `desktop.yml` | GitHub's `windows-latest` | | The Tauri build; runs only when GitHub's billing allows |

Each runner takes one job at a time; the two can run at once. Fork pull requests never run here:
each job skips a pull request whose branch isn't in this repository, and the repository's setting
for running workflows from forks stays off.

## Why

GitHub-hosted jobs stopped starting on 2026-10-05 ("recent account payments have failed or your
spending limit needs to be increased"). GitHub still hands jobs to self-hosted runners while it
says that: probe run 37350213541 ran on `hearth-pc-win` that day. So CI moved to the PC rather
than stop, and the PC is the one place where a CI mistake could reach the real thing.

## What the guard protects

`ops/ci-runner/guard.ts` runs first in each job (right after the checkout it lives in), then again
at the top of every step that starts a server, takes a backup or restores one. It checks every
time it's run: the rules are in `guard-rules.ts`, which the tests import, so `guard.ts` needs no
test for being the main module, which a Node without `import.meta.main` (23.6 to 24.1) would fail,
skipping the guard without a word. It exits 1, naming each problem, unless every one of these
holds:

| The live Hearth's | CI's own, which the guard insists on |
| --- | --- |
| Postgres on 5432 (`HEARTH_DATABASE_URL`'s default) | `HEARTH_DATABASE_URL`, `HEARTH_TEST_DATABASE_URL`, `PGHOST` and `PGPORT` on localhost:5499, with no query string (it could move the host or port) |
| The `hearth` database | Databases named `hearth_ci_<run id>_<attempt>`, or that name and `_something` |
| Port 4400 (the default of `HEARTH_PORT` and of the end-to-end tests' `HEARTH_E2E_URL`), 4443 on Tailscale | `HEARTH_PORT`, `HEARTH_ORIGIN`, `HEARTH_E2E_URL` and `HEARTH_E2E_PORT` set, and they and `HEARTH_LOCAL_ORIGIN` on 4480-4499, loopback only |
| `D:\Hearth` and its data (`HEARTH_DATA_DIR`'s default is the working folder) | `HEARTH_DATA_DIR`, `HEARTH_BACKUP_DIR`, `RESTIC_CACHE_DIR` set, and under `RUNNER_TEMP` |
| Google Drive through `%APPDATA%\rclone\rclone.conf` | `RCLONE_CONFIG` set to an empty file under `RUNNER_TEMP`; no other `RCLONE_*` variable (they can define a remote) |
| The restic repository and its password | `HEARTH_BACKUP_REPOSITORY` and `RESTIC_REPOSITORY`, if set, a local folder under `RUNNER_TEMP`; `RESTIC_PASSWORD`, if set, starting `ci-`; no `RESTIC_PASSWORD_COMMAND`; no `HEARTH_VAULT_KEY` |
| Your Chrome, in your profile (Hearth opens it when it isn't a service) | `HEARTH_CHROME_LAUNCH=off`, except the Linux chrome-launch step: Playwright's Chromium, with `--user-data-dir` under `RUNNER_TEMP` |
| The services' settings (`HEARTH_AS_SERVICE=1`: the Jarvis task, `C:\ProgramData\Hearth`) | Not set |
| `D:\Hearth\.env` (`pnpm hearth` loads the `.env` of the folder it runs in) | No `.env` in the checkout |
| `D:\Hearth`, `C:\ProgramData\Hearth` | On Windows, the checkout and `RUNNER_TEMP` inside `D:\hearth-ci` and apart from both. On Linux, inside a container (`/.dockerenv`), with no Docker socket and no drive of the PC mounted |

The workflow sets each of these at the job (the folders under `RUNNER_TEMP` from its first step,
since a job's `env` can't see `runner.temp`), so nothing falls back to a default. It also sets
`TEMP`/`TMP` (Windows) and `TMPDIR` (Linux) under `RUNNER_TEMP`, and keeps pnpm's store and
Playwright's browsers in `D:\hearth-ci` or the container's work volume.

Things the guard can't see, and how they're handled:

- `hearth backup`'s restore check uses a scratch database, `hearth_restore_check`, on whatever
  cluster the run's database is on: CI's, never the live one. It's dropped when the check ends.
- The doctor (`hearth doctor`) reads Windows' view of the live services and tasks. It only asks;
  CI judges only its Server, Build and Migrations checks, which `HEARTH_PORT` and the run's
  database point at the CI server.
- `hearth restore --switch` and `hearth restart` restart the live services. CI runs neither.
- `ops/windows/test-control.ps1` (the Windows job's "update and restart scripts" step) runs
  control.ps1's `Stop-Jarvis`, `Stop-Hearth` and the rest with Windows faked, as you, whose
  account may stop the live services and end Jarvis's task. Before it calls them,
  `ops/windows/test-fence.ps1` follows every command they can reach and refuses unless each is the
  test's own fake, one of control.ps1's functions, or a cmdlet that only filters, prints or tells
  the time; it also refuses a command run by a variable and a .NET call that acts (`.Kill()`,
  `.Stop()`, writing a file). Being a function isn't enough: Windows' own `Stop-ScheduledTask` and
  `Start-ScheduledTask` are functions (the ScheduledTasks module's). The test moves ProgramData to
  a temp folder, as does the step, so the services folder, where a stop request ends the live
  Jarvis, is out of reach.

The guard stops mistakes, not attacks. The Windows job runs as you, with your rights: install.ps1
lets your account start and stop Hearth's services, and you can write to `D:\Hearth` and the
services folder. The container can still reach the PC's ports through Docker Desktop's host
address (its names `host.docker.internal` and `gateway.docker.internal` point back at the
container itself). So anyone who can push a branch here can run code on this PC, as Claude's
sessions already do when they run the tests. Keep the repository private, and never give a
self-hosted runner a GitHub-hosted label (`windows-latest`, `ubuntu-latest`): jobs meant for
GitHub's machines would land here. A Windows account of the runner's own, without those rights,
would close the gap; making one needs an administrator.

The variables each job sets are `WINDOWS` and `LINUX` in `ops/ci-runner/guard.test.ts`; give
`node ops/ci-runner/guard.ts` those to try it by hand.

## Cleaning up

The Windows job's last step always runs, after a failure or a cancel too. It stops programs run
from `D:\hearth-ci` that listen on 4480-4499 (the CI servers, from the job's own Node) and
Playwright's Chromium, then drops this run's databases on 5499 (`hearth_ci_<run>_<attempt>` and
`..._restored`). It drops nothing if `PGHOST`/`PGPORT` aren't CI's. The Linux job stops its servers
and its Postgres, whose cluster goes with `RUNNER_TEMP`. The runner also ends whatever a job left
running.

If the PC restarts mid-job, that run's databases stay. List and drop them on 5499:

```powershell
psql -h 127.0.0.1 -p 5499 -U hearth -d postgres -Atc "SELECT datname FROM pg_database WHERE datname LIKE 'hearth\_ci\_%'"
psql -h 127.0.0.1 -p 5499 -U hearth -d postgres -c "DROP DATABASE hearth_ci_<run>_<attempt> WITH (FORCE)"
```

A cancelled test run can also leave `hearth_test_<random>` databases there, as an interrupted test
run on your PC always could.

## Resource caps

- **Windows:** one job at a time, at below-normal priority. Windows gives a program started at
  below-normal the same priority for everything it starts, so the tests, servers and Chromium yield
  to the live Hearth. The tests run 4 files at a time (`pnpm test --maxWorkers=4`; with `--` in
  between, pnpm passes the `--` on and vitest ignores what follows it). 45 minutes at most.
- **Linux:** the container gets 4 CPUs, 8 GB of memory (no swap) and 1 GB of shared memory
  (Chromium and Postgres use it). Tests run 4 files at a time. 30 minutes at most.
- Both at once use about half of the PC's 16 cores at their busiest.
- `HEARTH_PERF_SLACK` is 3 on both: timed tests get three times a developer's PC's budget, since
  CI runs beside the live Hearth at lower priority (Windows) or under a CPU quota (Linux), where a
  timed run can wait its turn. Three still fails a tenfold slowdown.

## Disk

C: has about 18 GB free, and Docker Desktop keeps its disk image there by default. The Linux
runner's image is about 1.5 GB (an estimate: `-Build` prints the real size), and its work volume
grows to about 3 GB (Node, the pnpm store, Playwright's Chromium, the checkout). **Move Docker
Desktop's disk image to D:** before building it: Docker Desktop, Settings, Resources, Advanced,
Disk image location.

Everything else CI keeps is in `D:\hearth-ci`: the Windows runner and its work folder, the tool
cache with its Node, the pnpm store (`pnpm-store`) and Playwright's Chromium (`ms-playwright`).
The Postgres cluster on 5499 keeps its data in `%LOCALAPPDATA%\HearthTestDb`, on C:, but each
run's database is dropped at the end.

## Adding and removing runners

**Windows** (`hearth-pc-win`, already set up). To set it up again: download GitHub's runner for
Windows x64 into `D:\hearth-ci\runner-win`, then, as you and unelevated, run
`config.cmd --url https://github.com/WallyThePenguin/ReverseEngineer --token <token> --name
hearth-pc-win --labels hearth-ci --work D:\hearth-ci\_work-win`, saying no to running it as a
service. Get the token from the repository's Settings, Actions, Runners, New self-hosted runner,
or with `gh api -X POST repos/WallyThePenguin/ReverseEngineer/actions/runners/registration-token
--jq .token`. Then:

```powershell
powershell -File ops\ci-runner\windows-runner.ps1 -Install   # start it at every sign-in
powershell -File ops\ci-runner\windows-runner.ps1 -Start     # start it now, hidden
powershell -File ops\ci-runner\windows-runner.ps1 -Status
powershell -File ops\ci-runner\windows-runner.ps1 -Stop
```

`-Install` copies the script to `D:\hearth-ci` and puts a shortcut in your Startup folder. Neither
needs administrator, and neither registers or reconfigures the runner.

**Linux** (`hearth-pc-linux`). With Docker Desktop running (and its disk image on D:):

```powershell
powershell -File ops\ci-runner\linux-runner.ps1 -Build    # build hearth-ci-linux:2.337.0
powershell -File ops\ci-runner\linux-runner.ps1 -Start    # the first start registers it
powershell -File ops\ci-runner\linux-runner.ps1 -Status
powershell -File ops\ci-runner\linux-runner.ps1 -Stop     # stops and removes the container
```

The first `-Start` gets a registration token with `gh` and hands it to the container without
showing it; the container registers, keeps its registration in the `hearth-ci-linux-config`
volume, and runs. Later starts, and new containers after a `-Build`, need no token. The container
restarts with Docker Desktop, so start Docker Desktop when you sign in. To move to a newer runner
version, change the tag in `ops/ci-runner/linux/Dockerfile` and `linux-runner.ps1`, then `-Build`,
`-Stop`, `-Start`.

**Removing one.** Stop it, then remove it in the repository's Settings, Actions, Runners (or with
`config.cmd remove --token <token>` on Windows, the token from `gh api -X POST
repos/WallyThePenguin/ReverseEngineer/actions/runners/remove-token --jq .token`). For the Linux
one, also `docker volume rm hearth-ci-linux-config hearth-ci-linux-work`. Jobs wait for a runner
with their labels, so a job with none left stays queued.

## When GitHub's runners come back

`desktop.yml` stays on `windows-latest` and runs only when billing allows. The CI jobs can go back
by changing their `runs-on`; the guard is only needed on this PC.

The real Windows install runs `install.ps1` as administrator: services, Jarvis's task, the backup
task, then updates and a rollback. That must never run on this PC, where it would install over the
live Hearth, so it isn't in `ci.yml`. It's `.github/workflows/windows-install.yml`:

- `runs-on: windows-latest` only: GitHub's disposable machines, never a self-hosted label. Its first
  step refuses to go on unless `RUNNER_ENVIRONMENT` is `github-hosted`.
- On pull requests and pushes to the deploy branch that change `ops/windows/**`, Jarvis
  (`apps/jarvis/src/**`, `packages/jarvis/src/service.ts`), the CLI (`apps/cli/src/**`) or the
  workflow file itself, plus `workflow_dispatch`.
- It runs when GitHub's billing allows. Until then its runs fail to start, which doesn't hold up
  merges: it isn't a required check.
- `ops/windows/test-install.ps1` refuses too: on anything but a GitHub-hosted runner, where
  `D:\Hearth` exists, or, for the install, where `hearth-server` is already a service.

`test-control.ps1` stays in `ci.yml`'s `windows` job, here on the PC. It dot-sources:

- `test-control-jarvis.ps1`, the `Stop-Jarvis`, `Stop-Hearth` and `Start-Hearth` tests. It calls
  `Assert-Fenced` before its first stop, with every fake that stops or starts something listed in
  `-Faked`.
- `test-control-update.ps1`, which runs the real `update.ps1` (in a Windows PowerShell of its own,
  through `test-update-fakes.ps1`) with git, pnpm, the services, Jarvis's task and its processes
  faked. `test-update-fakes.ps1` keeps ProgramData in its own work folder, and won't start
  `update.ps1` until every command that could reach Hearth is a function defined in that file (its
  `ScriptBlock.File`) or one of its refusals. Being a function isn't enough: Windows' own
  `Stop-ScheduledTask`, `Start-ScheduledTask`, `Register-ScheduledTask` and the rest already are.
