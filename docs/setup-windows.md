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

Run it from your own Windows account (right-click PowerShell, **Run as administrator**), not a
separate administrator account: Jarvis and the task that opens Chrome run as whoever installs it.
It asks nothing and takes under a minute. It installs two services, Jarvis's task, the backup
task, and the task that opens Chrome (section 10):

| What | Runs as | Does |
| --- | --- | --- |
| Hearth server (service) | LocalService | The web app, API and `/mcp` |
| Hearth worker (service) | LocalService | Schedules, reminders, health checks |
| Hearth Jarvis (task) | You | Jarvis, using your Claude login |

Jarvis is a scheduled task rather than a service so it can run as you without storing your
password. It starts two minutes after Windows starts (you needn't be signed in, so it's back
after an overnight Windows update) and when you sign in, and restarts if it stops.

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

It dumps the database and uploads it in one snapshot with mail's stored files and your voice
samples (never `vault.key`, the key to saved sign-ins and to the Google, Slack and GitHub
connections: keep a copy of `data\vault.key` in your password manager, or after a rebuild you'll
save those sign-ins and connect those accounts again; D58). It prunes old snapshots (keeping 7
daily, 4 weekly and 12 monthly), downloads the dump and a few stored files again, restores the
dump into a scratch database and checks it all. The result shows under **Settings → Health**.
If a night's backup fails, it lands in your inbox. Restic must be 0.17 or newer; `pnpm hearth
doctor` says if it isn't.

### Lock down the backups folder

The local dumps in `data\backups` hold your whole database, mail included. The services can read
everything in Hearth's folder, so they can read these too. Hearth doesn't change file permissions
by itself; to keep the dumps to you, run this once in PowerShell (elevated if Windows refuses):

```powershell
$backups = "C:\Hearth\data\backups"   # or your HEARTH_BACKUP_DIR
icacls $backups /inheritance:r /grant:r "${env:USERDOMAIN}\${env:USERNAME}:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"
icacls $backups
```

That leaves you, SYSTEM and Administrators, and takes away the services' and everyone else's
access. The nightly backup and `update.ps1` run as you, so they still write there.

## 8. Check everything

```powershell
pnpm hearth doctor
```

Every line should be ✓. A ! is a warning and says what to do; any ✗ makes it exit with an
error. Besides the setup, it checks the running install: the two services and Jarvis's task,
that the server answers and runs the code on disk, that the worker and Jarvis have reported in
recently (a component that's quiet for twice its interval fails, whatever it last said), how
many of Jarvis's turns failed in the last day, Tailscale Serve, and free space on every drive
Hearth uses, C: included.

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

## 10. Connect Chrome (Jarvis's browser)

Jarvis uses your own Chrome, signed in as you, through the Hearth extension. You watch it, and
take over with your mouse and keyboard, from the **Browser** pane in Hearth (`g b`), on the PC
or on your phone.

1. In Chrome, open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**,
   and pick `C:\Hearth\apps\extension`.
2. In Hearth, open **Settings → Chrome** and choose **Pair Chrome**. Copy the code; it's shown
   once.
3. Right-click the Hearth button in Chrome's toolbar and choose **Options**. Enter
   `http://127.0.0.1:4400` as the address (the extension talks to Hearth on this PC, not over
   Tailscale), paste the code, and save. It says **Connected**.

`install.ps1` (step 6) also set up a task, **Hearth Chrome**, that opens Chrome as you, in the
profile the Hearth extension is loaded in. Before the extension was loaded, that's the profile you
used last; if you loaded it into a different one, run `.\ops\windows\install.ps1` again and it
finds it. To choose one yourself, find its folder name on `chrome://version` (the end of
**Profile Path**, like `Profile 1`) and run `.\ops\windows\install.ps1 -ChromeProfile "Profile 1"`.
If you installed Hearth before this task existed, run `install.ps1` again to add it.

What to expect:

- Jarvis works in its own Chrome window, in a purple **Jarvis** tab group. The window opens
  without taking your keyboard, though it can show up on top of what you're doing. To let
  it use one of your tabs, click the Hearth button on that tab and choose **Let Jarvis use this
  tab**; **Take this tab back** returns it.
- While Jarvis is using a tab, Chrome shows a bar saying Hearth is debugging the browser. That's
  Chrome telling you, and it goes away a few minutes after Jarvis stops. Choosing **Cancel** on
  it cuts Jarvis off from that tab.
- In **Settings → Chrome → Never open**, add your bank. Password managers, your Google account
  settings and PayPal are on the list already. **Trusted sites** lists sites where Jarvis can
  act without asking: open them, click, type and send, even right after reading an email or a
  web page. Payments, passwords and security settings, sending money and deleting an account
  still always ask you first (D52).
- **Settings → Chrome → Test Jarvis's Chrome** opens a test page in Jarvis's window, reads it,
  clicks, types and takes a screenshot, and shows how long each step took. **Link activity**
  below it shows recent connects, drops and failed requests.
- The extension has a fixed ID (`jcpelnnklghgcdhcmdbmpflehbehpkhh`). After an update that
  changes it, reload the extension in `chrome://extensions` and pair it again.
- Page watches tell you when a page changes: ask Jarvis ("watch this kettle's price and tell me
  if it drops under $30"), or use **Watch** in the Browser pane. They're listed under
  **Settings → Chrome**.
- Hearth opens Chrome when Jarvis needs it. If Chrome is closed when Jarvis opens a page or a
  page watch runs, Hearth starts it, with no window of its own until Jarvis opens one. The
  Browser pane and **Settings → Chrome** have an **Open Chrome** button too. Chrome also opens
  when you sign in to Windows.
- Chrome now keeps running after you close its windows, so Jarvis can still use it. Its icon
  stays in the system tray (Windows mentions a "new background app" once). To quit Chrome
  completely, right-click that icon and choose **Exit**; Hearth opens it again the next time
  Jarvis needs it. This needs Chrome's **Continue running background apps when Google Chrome is
  closed** setting, which is on unless you turned it off (`chrome://settings/system`). If you
  have Chrome clear cookies and site data when you close all windows, that now happens when you
  choose **Exit**.
- Windows only opens Chrome for Hearth while you're signed in on the PC. When you're signed
  out, Jarvis and page watches wait, and the Browser pane says why.
- If Chrome is set to continue where you left off, your last tabs come back the first time
  Jarvis opens a window in a Chrome with none open. They stay in a window of their own, apart
  from Jarvis's.
- Task Scheduler shows **Hearth Chrome** as running while a Chrome it opened is open. Ending
  the task there closes Chrome.
- If Jarvis's window is minimized or covered, or the PC is locked or its screen is off, Chrome
  stops drawing it and the live view drops to about one picture a second. Jarvis can still read
  and watch pages.

## Using Hearth

- `Ctrl+K` searches everything, runs commands, makes a task, or asks Jarvis.
- `Ctrl+J` shows or hides Jarvis. `?` lists every shortcut.
- `g b` opens the Browser: your Chrome, live, with Jarvis's tabs and the ones you handed it.
- In the inbox: `j`/`k` to move, `e` done, `s` snooze, `a`/`d` approve or deny.
- Type `@` in a note, task or comment to link anything, or `@Jarvis` to ask for help right there.
- Give a task to Jarvis and it works on it, reporting in the task's thread.
- **Settings → Pause** stops Jarvis acting on its own. It still answers you, and deadline and
  failure alerts still arrive.

## Hearth for Windows

The desktop app (`D:\HearthDesktop\hearth.exe`) starts hidden when you sign in to Windows and
waits in the system tray. `Ctrl+Alt+H` opens Hearth's window, and so does clicking the tray icon.

Right-click the tray icon for its menu. The top line says how the server, the worker and Jarvis
are doing. Below it: **Open Hearth**, **Quick capture**, **Record a meeting** (**Stop recording
the meeting** while it records), **Voice settings...**, and **Restart Hearth services** and
**Update Hearth…** for when something's wrong.

Its shortcuts work in any program. Change them in **Voice settings...**.

| Keys | What it does |
| --- | --- |
| `Ctrl+Alt+H` | Opens Hearth's window. |
| `Ctrl+Alt+N` | Quick capture: a small box to jot down a task. |
| `Ctrl+Alt+K` | Ask Jarvis: a small window to ask by typing. |
| `Ctrl+Alt+J` | Hold and ask Jarvis anything; it answers out loud. |
| `Ctrl+Alt+Space` | Select text, hold and say what to do with it; Jarvis's answer replaces it. |
| `Ctrl+Space` | Hold and talk: what you say is typed where you are. |
| `Ctrl+Shift+Space` | The same, run through post-processing first (set up under **Post Process**). |

Talking to Jarvis and dictation need a speech model on the PC, downloaded once: open **Voice
settings...**, go to **Models** and download one (Parakeet V3 is the one D13 chose). Until then
the voice shortcuts do nothing.

## When something's wrong

- `pnpm hearth doctor` first.
- The Browser pane says Chrome isn't connected: choose **Open Chrome** there. If it says why it
  couldn't, do what it says. If Chrome opens but doesn't connect, open the extension's options;
  it says why (often an old pairing code: pair again in Settings). `pnpm hearth doctor` checks
  the **Hearth Chrome** task.
- Service logs are in `C:\ProgramData\Hearth\services\` (one set per service).
- Restart Hearth: `pnpm hearth restart` (all of it), or `pnpm hearth restart server` (or
  `worker`, or `jarvis`). It waits until what it restarted reports in, and says if it doesn't.
  It needs no administrator once `install.ps1` has run. Jarvis's log is `hearth-jarvis.log` in
  the same folder as the services'.
- If a restart, an update or `pnpm hearth doctor` says an older Jarvis is still running and
  Hearth can't stop it from your account, that Jarvis is from before Jarvis stopped when asked
  (D63). While it runs, the task can't start a new one. Run the `taskkill` line it prints as
  administrator (or run `install.ps1` again), then `pnpm hearth restart jarvis`.
- If a service log says `EPERM`, its account can't read `node_modules`: run
  `Remove-Item -Recurse -Force node_modules`, then `pnpm install`, then `pnpm hearth restart`.
- If a service log says it "won't start" because the database is missing updates, run
  `pnpm hearth migrate`; if it says the database is newer than the code, update Hearth or
  restore the backup taken before the last update (below).

### Updating Hearth

From a normal (not elevated) PowerShell in the Hearth folder:

```powershell
.\ops\windows\update.ps1
```

It asks `hearth doctor` how things are, takes a safety dump (`data\backups\pre-update-*.dump`),
stops Hearth, moves to the latest commit, installs, builds, migrates and starts everything again.
Then the new version has three minutes to prove itself, or it's rolled back (D57):

- the server reports the new commit, with every migration it expects applied;
- the worker and Jarvis report in after the restart, not failing (if one was failing before the
  update, reporting in is enough: the update may be what fixes it);
- Jarvis's tools pass the model's check, when that probe (`scripts\probe-jarvis-tools.ts`) exists;
- `hearth doctor` finds nothing failing that wasn't failing before the update.

A rollback reverts the update's migrations, puts the previous code back, starts it and checks it
came back. The log is `data\logs\update-<date>.log`. When an update changes how the services are
installed, it says to run `.\ops\windows\install.ps1` again as administrator.

When an update changes `update.ps1` itself (or `control.ps1`), the new copy takes over right after
the merge, so the new checks judge the new code.

**First update after this change.** The `update.ps1` already in your Hearth folder runs that update,
and if it doesn't mention `-Relaunched` yet, it can't hand over: it would judge the new code by its
old checks. Run the new one directly that once, from the Hearth folder:

```powershell
git fetch origin claude/admiring-wright-ghc2o3
$tmp = New-Item -ItemType Directory -Force "$env:TEMP\hearth-update"
foreach ($f in "update.ps1", "control.ps1", "control-jarvis.ps1") {
  git show "origin/claude/admiring-wright-ghc2o3:ops/windows/$f" | Set-Content "$tmp\$f"
}
& "$tmp\update.ps1" -Root (Get-Location).Path
```

`-Root` says where Hearth is, since that copy isn't in its folder.

**Stopping Jarvis (D63).** Your account can't end the task's Jarvis, so updates and
`hearth restart` ask it to stop and wait for it. A Hearth from before D63 doesn't stop when asked,
so the first update to D63 ends at "Making sure Jarvis has stopped". It names the old Jarvis's pid
and rolls back with that Jarvis left running. Then:

1. In an administrator PowerShell, run the `taskkill /F /PID <pid>` it printed.
2. Run `.\ops\windows\update.ps1` again within about three minutes. After that, the old Hearth's
   worker starts its Jarvis again, and the old update would leave that one running too.

Restarting the PC doesn't help: the old Jarvis starts again at boot, in the same state.

### Restoring from a backup

`hearth restore` brings a backup back into a **new** database next to the one Hearth runs on,
so trying one costs nothing:

```powershell
pnpm hearth restore                       # the newest backup (off-site if set up, else data\backups)
pnpm hearth restore 4f2a9c1e              # a snapshot from: restic -r rclone:gdrive:hearth-backups snapshots
pnpm hearth restore data\backups\pre-update-20261004-020000.dump   # a dump file
```

It restores the dump in one transaction (all or nothing), applies any updates the backup is
missing, refuses a backup from a newer Hearth, puts back mail's stored files and voice samples
that are missing here (keeping the ones you have), and checks the result. Then it prints how to
switch to it:

1. In `.env`, change the database at the end of `HEARTH_DATABASE_URL` to the new one it names,
   like `.../hearth_restored_20261004_165012`.
2. `pnpm hearth restart`
3. `pnpm hearth doctor`

Add `--switch` to have it do 1 and 2; it keeps your old `.env` as `.env.before-restore-<time>`.
To go back, put the old database name back and restart: the old database is never touched.
Saved sign-ins, and the Google, Slack and GitHub connections, come back only if `data\vault.key`
is the one they were saved with; otherwise save and connect them again in Settings.

### Removing Hearth's services

```powershell
.\ops\windows\uninstall.ps1
```

This leaves your database and backups alone.
