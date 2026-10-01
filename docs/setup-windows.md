# Setting up Hearth on your Windows PC

This takes about 45 minutes, once. At the end, Hearth starts with Windows, you open it from any
of your devices over Tailscale, Jarvis runs on your Claude subscription, and a backup goes to
Google Drive every night, with a restore test each time.

Everything here is free except what you already pay for (Claude and Google One).

## 1. Install the tools

In PowerShell:

```powershell
winget install OpenJS.NodeJS.LTS          # Node 24
winget install PostgreSQL.PostgreSQL.17
winget install Git.Git
winget install tailscale.tailscale
winget install restic.restic
winget install Rclone.Rclone
npm install -g pnpm @anthropic-ai/claude-code
```

Then:

- Add PostgreSQL's `bin` folder (for example `C:\Program Files\PostgreSQL\17\bin`) to your
  PATH, so `pg_dump` works for backups.
- Run `claude` once and sign in with your Claude account. Jarvis uses this login.
- Sign in to Tailscale.

Install Node with the installer above, not with nvm. The services run as a separate low-rights
account and need to find Node in Program Files.

## 2. Create the database

Open `psql` as the `postgres` user (the installer asked you for its password) and run, with a
password of your own:

```sql
CREATE ROLE hearth LOGIN CREATEDB PASSWORD 'pick-a-long-password';
CREATE DATABASE hearth OWNER hearth;
```

`CREATEDB` lets the nightly backup restore into a scratch database to prove the backup works.

## 3. Get Hearth

```powershell
git clone https://github.com/wallythepenguin/reverseengineer C:\Hearth
cd C:\Hearth
pnpm install
pnpm build:web
copy .env.example .env
notepad .env
```

In `.env`, set `HEARTH_DATABASE_URL` with the password from step 2. Leave the rest for now.

## 4. Put Hearth on your tailnet

```powershell
tailscale serve --bg 4400
tailscale serve status
```

The status shows an address like `https://desktop.tail1234.ts.net`. Set `HEARTH_ORIGIN` in `.env`
to that address. Passkeys are tied to it, so do this before step 5.

Only devices on your tailnet can reach it. Nothing is exposed to the internet.

## 5. Add your first passkey

```powershell
pnpm hearth setup
```

This prepares the database and prints a one-time code. Open your `HEARTH_ORIGIN` address, enter
the code, and create a passkey with Windows Hello. To sign in from your phone too, open Hearth
there later and use **Settings → Add a passkey** from a signed-in device.

## 6. Install the services

In PowerShell **run as administrator**:

```powershell
cd C:\Hearth
.\ops\windows\install.ps1
```

This installs three services and the backup task:

| Service | Runs as | Does |
| --- | --- | --- |
| Hearth server | LocalService | The web app, API and `/mcp` |
| Hearth worker | LocalService | Schedules, reminders, health checks |
| Hearth Jarvis | You | Jarvis, using your Claude login |

When it asks, enter your Windows account (for example `.\yourname`) and password for Jarvis's
service, and answer `y` to let it log on as a service. Windows keeps that password. Hearth never
sees it.

## 7. Turn on off-site backups (Google Drive)

```powershell
rclone config
```

Create a remote named `gdrive` of type `drive`, with scope `drive.file` (rclone can only see
files it created). Then choose a backup password and keep a copy somewhere safe, like your
password manager. Without it the backups can't be read.

```powershell
"your-backup-password" | Out-File -NoNewline $HOME\.hearth-restic-password
$env:RESTIC_PASSWORD_FILE = "$HOME\.hearth-restic-password"
restic -r rclone:gdrive:hearth-backups init
```

Check that `.env` has `HEARTH_BACKUP_REPOSITORY=rclone:gdrive:hearth-backups` and the right
`RESTIC_PASSWORD_FILE`, then run a backup now:

```powershell
pnpm hearth backup
```

It dumps the database, uploads it, prunes old snapshots (keeping 7 daily, 5 weekly and 12
monthly), downloads the new snapshot again, restores it into a scratch database, and checks it.
The result shows under **Settings → Health**. If a night's backup fails, it lands in your inbox.

## 8. Check everything

```powershell
pnpm hearth doctor
```

Every line should be ✓. A ! is a warning and says what to do.

## 9. Connect Claude Code (optional)

Claude Code, Claude Desktop and other MCP clients can use Hearth too. Each gets its own token and
shows up under its own name. They can't send anything in your name, and anything risky waits for
your approval in the inbox.

```powershell
pnpm hearth token create claude-code
claude mcp add --transport http hearth https://desktop.tail1234.ts.net/mcp --header "Authorization: Bearer <the token>"
```

`pnpm hearth token list` shows the tokens and when each was last used, and
`pnpm hearth token revoke claude-code` cuts one off.

## Using Hearth

- `Ctrl+K` searches everything, runs commands, makes a task, or asks Jarvis.
- `Ctrl+J` shows or hides Jarvis. `?` lists every shortcut.
- In the inbox: `j`/`k` to move, `e` done, `s` snooze, `a`/`d` approve or deny.
- Type `@` in a note, task or comment to link anything, or `@Jarvis` to ask for help right there.
- Give a task to Jarvis and it works on it, reporting in the task's thread.
- **Settings → Pause** stops Jarvis acting on its own. It still answers you, and deadline and
  failure alerts still arrive.

## When something's wrong

- `pnpm hearth doctor` first.
- Service logs are in `C:\ProgramData\Hearth\services\` (one set per service).
- Restart a service: `Restart-Service hearth-jarvis` (or `hearth-server`, `hearth-worker`).
- To update Hearth: `git pull`, `pnpm install`, `pnpm build:web`, `pnpm hearth migrate`, then
  restart the three services.

### Restoring from a backup

```powershell
restic -r rclone:gdrive:hearth-backups snapshots
restic -r rclone:gdrive:hearth-backups restore latest --target C:\HearthRestore
Stop-Service hearth-jarvis, hearth-worker, hearth-server
pg_restore --clean --if-exists --no-owner --dbname "<HEARTH_DATABASE_URL>" C:\HearthRestore\...\hearth-<date>.dump
Start-Service hearth-server, hearth-worker, hearth-jarvis
```

### Removing Hearth's services

```powershell
.\ops\windows\uninstall.ps1
```

This leaves your database and backups alone.
