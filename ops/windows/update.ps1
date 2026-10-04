<#
.SYNOPSIS
  Updates Hearth in place, from your own account: no administrator needed.

.DESCRIPTION
  install.ps1 lets your account stop and start Hearth's two services and the "Hearth Jarvis" task,
  so this runs unelevated. It takes a safety dump, stops Hearth, moves to the latest commit of the
  branch, installs, builds, migrates, starts everything again and checks that Hearth answers.

  - Any failure puts the previous code back and starts that. Migrations this update applied are
    reverted first (`hearth migrate down`, newest first); should that fail, the new code stays and
    the safety dump in data\backups is the way back.
  - When the update changes the service definitions or install.ps1, it says to run install.ps1
    again as administrator; everything else still updates.

  Log: data\logs\update-<time>.log. Exit code 0 means Hearth is up on the new code.
#>
[CmdletBinding()]
param(
  [string]$Root = (Resolve-Path "$PSScriptRoot\..\..").Path,
  [string]$Branch = "claude/admiring-wright-ghc2o3",
  # Run every step even when already on the latest commit.
  [switch]$Force
)
$ErrorActionPreference = "Stop"
Set-Location $Root
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
New-Item -ItemType Directory -Force "$Root\data\logs", "$Root\data\backups" | Out-Null
Start-Transcript -Path "$Root\data\logs\update-$stamp.log" | Out-Null

# One update at a time: the lock file stays open (and locked) until this script ends.
try {
  $lock = [IO.File]::Open("$Root\data\update.lock", "OpenOrCreate", "ReadWrite", "None")
} catch {
  Write-Host "Another update is running."
  Stop-Transcript | Out-Null
  exit 2
}

function Invoke-Native([string]$What, [scriptblock]$Do) {
  Write-Host "== $What"
  & $Do
  if ($LASTEXITCODE -ne 0) { throw "$What failed (exit $LASTEXITCODE)." }
}

function Get-EnvValue([string]$Name) {
  $line = Get-Content "$Root\.env" | Where-Object { $_ -match "^$Name=" } | Select-Object -First 1
  if ($line) { return ($line -replace "^$Name=", "").Trim() }
  return $null
}

function Stop-Jarvis {
  # Jarvis runs under cmd in the task; stopping the task ends cmd but not always the node under
  # it, and an unelevated account can't read session-0 command lines. So: the pid Jarvis wrote at
  # startup, plus every child of the task's running process.
  $pids = @()
  $pidFile = "$env:ProgramData\Hearth\services\hearth-jarvis.pid"
  if (Test-Path $pidFile) { $pids += [int](Get-Content $pidFile -Raw).Trim() }
  $scheduler = New-Object -ComObject Schedule.Service
  $scheduler.Connect()
  $task = $scheduler.GetFolder("\").GetTask("Hearth Jarvis")
  foreach ($run in @($task.GetInstances(0))) {
    $pids += @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($run.EnginePID)" |
      Where-Object { $_.Name -eq "node.exe" } | ForEach-Object { $_.ProcessId })
  }
  Stop-ScheduledTask -TaskName "Hearth Jarvis" -ErrorAction SilentlyContinue
  foreach ($p in ($pids | Select-Object -Unique)) {
    $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -eq "node") { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
  }
}

function Stop-Hearth {
  Write-Host "== Stopping Hearth"
  Stop-Jarvis
  Stop-Service hearth-server, hearth-worker
}

function Start-Hearth {
  Write-Host "== Starting Hearth"
  Start-Service hearth-server, hearth-worker
  Start-ScheduledTask -TaskName "Hearth Jarvis"
}

# Waits for the server to answer /api/health, up to a minute.
function Test-Hearth {
  $port = Get-EnvValue "HEARTH_PORT"
  if (-not $port) { $port = "4400" }
  for ($i = 0; $i -lt 30; $i++) {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 "http://127.0.0.1:$port/api/health"
      if ($r.StatusCode -eq 200) { return $true }
    } catch {}
    Start-Sleep -Seconds 2
  }
  return $false
}

$old = (git rev-parse HEAD).Trim()
$exit = 1
$applied = @()
$stopped = $false
try {
  if (git status --porcelain --untracked-files=no) {
    throw "The Hearth folder has uncommitted changes to tracked files. Nothing was changed."
  }
  Invoke-Native "Fetching $Branch" { git fetch origin $Branch }
  $new = (git rev-parse "origin/$Branch").Trim()
  if ($new -eq $old -and -not $Force) { throw [System.OperationCanceledException]::new("up to date") }
  git merge-base --is-ancestor $old $new
  if ($LASTEXITCODE -ne 0) { throw "origin/$Branch isn't ahead of this folder's commit; nothing was changed." }
  Write-Host "Updating $($old.Substring(0, 7)) -> $($new.Substring(0, 7)):"
  git log --oneline "$old..$new"
  $needsInstall = @(git diff --name-only $old $new -- ops/windows/install.ps1 "ops/windows/*.xml").Count -gt 0

  $dump = "$Root\data\backups\pre-update-$stamp.dump"
  Invoke-Native "Safety dump: $dump" { pg_dump --format=custom --file $dump --dbname (Get-EnvValue "HEARTH_DATABASE_URL") }

  Stop-Hearth
  $stopped = $true
  Invoke-Native "Moving to $($new.Substring(0, 7))" { git merge --ff-only $new }
  Invoke-Native "Installing packages" { pnpm install --frozen-lockfile }
  Invoke-Native "Building the web app" { pnpm build:web }
  Write-Host "== Migrating the database"
  # stdout only: in Windows PowerShell, redirected stderr would turn any Node warning into an error.
  $out = pnpm --silent hearth migrate | Out-String
  Write-Host $out
  if ($out -match "Applied: (.+)") { $applied = @($Matches[1].Trim() -split ",\s*") }
  if ($LASTEXITCODE -ne 0) { throw "Migrating the database failed (exit $LASTEXITCODE)." }
  Start-Hearth
  $stopped = $false
  if (-not (Test-Hearth)) { throw "Hearth didn't answer /api/health within a minute after the update." }
  Invoke-Native "Checking with hearth doctor" { pnpm hearth doctor }
  if ($needsInstall) {
    Write-Warning "This update changed how the services are installed. Run ops\windows\install.ps1 again from an elevated PowerShell."
  }
  Write-Host "== DONE: Hearth is up on $($new.Substring(0, 7))."
  $exit = 0
} catch [System.OperationCanceledException] {
  Write-Host "Already up to date ($($old.Substring(0, 7)))."
  $exit = 0
} catch {
  Write-Host "UPDATE FAILED: $_"
  if ((git rev-parse HEAD).Trim() -ne $old) {
    if (-not $stopped) { Stop-Hearth; $stopped = $true }
    $reverted = $true
    foreach ($name in $applied) {
      Write-Host "== Reverting migration (newest first; this update applied $($applied -join ', '))"
      pnpm --silent hearth migrate down
      if ($LASTEXITCODE -ne 0) { $reverted = $false; break }
    }
    if ($reverted) {
      Write-Host "== Putting the previous code back ($($old.Substring(0, 7)))"
      git reset --hard $old
      pnpm install --frozen-lockfile
      pnpm build:web
    } else {
      Write-Host "A migration wouldn't revert, so the new code stays. The safety dump is in data\backups."
    }
  }
  if ($stopped) {
    try { Start-Hearth } catch { Write-Host "Couldn't start Hearth again: $_" }
  }
} finally {
  $lock.Dispose()
  Stop-Transcript | Out-Null
}
exit $exit
