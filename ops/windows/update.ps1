<#
.SYNOPSIS
  Updates Hearth in place, from your own account: no administrator needed.

.DESCRIPTION
  install.ps1 lets your account stop and start Hearth's two services and the "Hearth Jarvis" task,
  so this runs unelevated. It asks hearth doctor how things are, takes a safety dump, stops Hearth,
  moves to the latest commit of the branch, installs, builds, migrates and starts everything again.
  Your account can't end the task's Jarvis, so it's asked to stop (D63) and waited for: one that
  won't go ends the update there, saying which pid an administrator has to end.
  Then the update has to prove itself (D57), or it's rolled back:

  - The server reports the new commit through /api/health/deep, its database has every migration
    the new code expects, and the worker and Jarvis report in after the restart, not failing
    (unless they were failing before the update: then reporting in is enough). Within three
    minutes.
  - When scripts\probe-jarvis-tools.ts exists, it passes (exit 0). That's the hook for the Jarvis
    tool-schema probe: it sends Jarvis's whole tool list to the model in one small call, so a tool
    the API rejects stops the update instead of every Jarvis turn.
  - hearth doctor finds nothing failing that wasn't failing before the update. What already failed
    (a full disk, say) is listed but doesn't block a fix; a check the old doctor didn't have can't
    be compared, so it's listed as a warning.

  Rolling back reverts the migrations this update applied, even those before one that failed
  (`hearth migrate down <name>`, newest first), puts the previous code back, starts it and checks
  that it came back. Should a migration not revert, the new code stays and the database is
  migrated again to fit it; the safety dump in data\backups is the way back.

  When the update changes the service definitions or install.ps1, it says to run install.ps1
  again as administrator; everything else still updates.

  When the update changes this script or control.ps1, the new copy takes over right after the
  merge (-Relaunched), so the new gate and rollback judge the new code. This run keeps the lock,
  waits for it and exits with its exit code; should it not start, this run rolls back.

  Log: data\logs\update-<date>.log, one per day, appended. Exit code 0 means Hearth is up and
  healthy on the new code.
#>
[CmdletBinding()]
param(
  # Hearth's folder; by default the one this script is in.
  [string]$Root,
  [string]$Branch = "claude/admiring-wright-ghc2o3",
  # Run every step even when already on the latest commit.
  [switch]$Force,
  # The optional Jarvis tool-schema probe, relative to $Root (see above).
  [string]$JarvisProbe = "scripts\probe-jarvis-tools.ts",
  # How long the new code gets to report in healthy.
  [int]$HealthTimeoutSec = 180,
  # Set by update.ps1 when the update changed it: carry on from the merge, where the run that
  # started this one left off (data\update-handover.xml), and never hand over again.
  [switch]$Relaunched
)
$ErrorActionPreference = "Stop"
# Not as the parameter's default: Windows PowerShell leaves $PSScriptRoot empty there for a script
# run with -File, as the desktop app's "Update Hearth" runs this.
if (-not $Root) { $Root = (Resolve-Path "$PSScriptRoot\..\..").Path }
Set-Location $Root
. "$PSScriptRoot\control.ps1"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
New-Item -ItemType Directory -Force "$Root\data\logs", "$Root\data\backups" | Out-Null
$log = "$Root\data\logs\update-$(Get-Date -Format yyyy-MM-dd).log"
Start-Transcript -Append -Path $log | Out-Null
# hearth doctor writes UTF-8; read it as UTF-8 (for this window only, put back at the end).
$consoleEncoding = [Console]::OutputEncoding
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$handoverFile = "$Root\data\update-handover.xml"

# One update at a time: the lock file stays open (and locked) until this script ends. A relaunched
# copy runs under the lock of the run that started it, which waits for it.
$lock = $null
if ($Relaunched) {
  if (-not (Test-Path $handoverFile)) {
    Write-Host "There's no update to carry on with: -Relaunched is for update.ps1 itself."
    Stop-Transcript | Out-Null
    exit 2
  }
} else {
  try {
    $lock = [IO.File]::Open("$Root\data\update.lock", "OpenOrCreate", "ReadWrite", "None")
  } catch {
    Write-Host "Another update is running."
    Stop-Transcript | Out-Null
    exit 2
  }
}

function Invoke-Native([string]$What, [scriptblock]$Do) {
  Write-Host "== $What"
  & $Do
  if ($LASTEXITCODE -ne 0) { throw "$What failed (exit $LASTEXITCODE)." }
}

function Write-Doctor($Report) {
  foreach ($c in $Report.Checks) { Write-Host ("{0,-5} {1,-14} {2}" -f $c.mark, $c.name, $c.detail) }
}

# The new code must prove itself: deep health, the Jarvis probe if there is one, then the doctor.
function Assert-Healthy([string]$Sha, [datetime]$Since, $Before) {
  Write-Host "== Waiting for Hearth to report in on $(Format-Sha $Sha)"
  $failed = Get-FailingChecks $Before
  if ($failed.Count) { Write-Host "Failing before the update too, so they only have to report in: $($failed -join ', ')" }
  $why = Wait-Hearth -Since $Since -Sha $Sha -TimeoutSec $HealthTimeoutSec -Failed $failed
  if ($why) { throw "Hearth isn't healthy on the new code after $HealthTimeoutSec seconds: $why." }
  $probe = Join-Path $Root $JarvisProbe
  if (Test-Path $probe) {
    Invoke-Native "Checking Jarvis's tools with the model ($JarvisProbe)" { node --env-file-if-exists=.env $probe }
  } else {
    Write-Host "== No Jarvis tool probe ($JarvisProbe), skipping it"
  }
  Write-Host "== Checking with hearth doctor"
  $after = Get-DoctorReport
  if (-not $after.Checks) { throw "hearth doctor didn't run on the new code: $($after.Text)" }
  Write-Doctor $after
  $diff = Compare-Doctor $Before $after
  foreach ($c in $diff.Old) { Write-Host "Still failing, as before the update: $($c.name): $($c.detail)" }
  foreach ($c in $diff.Unknown) { Write-Warning "Failing, and not checked before the update: $($c.name): $($c.detail)" }
  if ($diff.New.Count) {
    $what = ($diff.New | ForEach-Object { "$($_.name): $($_.detail)" }) -join "; "
    throw "hearth doctor found new problems: $what"
  }
}

$exit = 1
$applied = @()
$stopped = $false
if ($Relaunched) {
  # Where the run that started this one left off: Hearth stopped, the new commit merged. Deleting
  # the file says this copy has taken over, rollback included.
  $state = Import-Clixml $handoverFile
  Remove-Item $handoverFile
  $old = $state.Old
  $new = $state.New
  $before = $state.Before
  $stopped = $true
  Write-Host "== Carrying on with the updated update.ps1"
} else {
  $old = (git rev-parse HEAD).Trim()
}
try {
  if (-not $Relaunched) {
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

    Write-Host "== Asking hearth doctor how things are before the update"
    $before = Get-DoctorReport
    if ($before.Checks) { Write-Doctor $before } else { Write-Host $before.Text }

    $dump = "$Root\data\backups\pre-update-$stamp.dump"
    Invoke-Native "Safety dump: $dump" { pg_dump --format=custom --file $dump --dbname (Get-EnvValue "HEARTH_DATABASE_URL") }

    Stop-Hearth
    $stopped = $true
    Invoke-Native "Moving to $($new.Substring(0, 7))" { git merge --ff-only $new }
  } elseif ((git rev-parse HEAD).Trim() -ne $new) {
    throw "The Hearth folder isn't on $($new.Substring(0, 7)), where the update left off."
  } else {
    # The copy that started this one stopped Hearth with its own Stop-Jarvis, which before D63
    # could miss Jarvis without a word (2026-10-05). Make sure, before anything is installed.
    Write-Host "== Making sure Jarvis has stopped"
    $stuck = Stop-Jarvis
    if ($stuck) {
      throw "$stuck. (The Hearth you're updating from stops Jarvis the old way: if its worker starts that Jarvis again first, in about three minutes, the next update will leave it running too.)"
    }
  }
  $needsInstall = @(git diff --name-only $old $new -- ops/windows/install.ps1 "ops/windows/*.xml").Count -gt 0
  # This script was read before the merge; an update that changes it (or control.ps1) is carried
  # on by its new copy, which never hands over again.
  $updaterChanged = -not $Relaunched -and
    @(git diff --name-only $old $new -- ops/windows/update.ps1 ops/windows/control.ps1).Count -gt 0
  if ($updaterChanged) {
    Write-Host "== This update changes the updater: its new copy carries on from here"
    $exe = if ($PSVersionTable.PSEdition -eq "Core") { "$PSHOME\pwsh.exe" } else { "$PSHOME\powershell.exe" }
    $relaunch = Get-RelaunchArgs $PSBoundParameters "$Root\ops\windows\update.ps1" $Root
    $state = [pscustomobject]@{ Old = $old; New = $new; Before = $before }
    # The new copy keeps the same log.
    Stop-Transcript | Out-Null
    try {
      Invoke-Handover $exe $relaunch $state $handoverFile ([ref]$exit)
    } finally {
      # Never throws: once the new copy has taken over, the rollback is its alone. Rolling back
      # here as well would put the old code back on a database the new copy left migrated.
      try { Start-Transcript -Append -Path $log | Out-Null } catch {}
    }
  } else {
    Invoke-Native "Installing packages" { pnpm install --frozen-lockfile }
    Invoke-Native "Building the web app" { pnpm build:web }
    Write-Host "== Migrating the database"
    # stdout only: in Windows PowerShell, redirected stderr would turn any Node warning into an error.
    $out = pnpm --silent hearth migrate | Out-String
    $code = $LASTEXITCODE
    Write-Host $out
    # Read before the exit code: when a migration fails, those before it are still applied.
    $applied = @(Get-AppliedMigrations $out)
    if ($code -ne 0) { throw "Migrating the database failed (exit $code)." }
    $since = [datetime]::UtcNow
    Start-Hearth
    $stopped = $false
    Assert-Healthy $new $since $before
    if ($needsInstall) {
      Write-Warning "This update changed how the services are installed. Run ops\windows\install.ps1 again from an elevated PowerShell."
    }
    Write-Host "== DONE: Hearth is up on $($new.Substring(0, 7))."
    $exit = 0
  }
} catch [System.OperationCanceledException] {
  Write-Host "Already up to date ($($old.Substring(0, 7)))."
  $exit = 0
} catch {
  Write-Host "UPDATE FAILED: $_"
  if ((git rev-parse HEAD).Trim() -ne $old) {
    if (-not $stopped) { Stop-Hearth -Anyway; $stopped = $true }
    if ($applied.Count) { Write-Host "This update applied $($applied -join ', ')." }
    if (Undo-Migrations $applied) {
      Write-Host "== Putting the previous code back ($($old.Substring(0, 7)))"
      git reset --hard $old
      pnpm install --frozen-lockfile
      pnpm build:web
    } else {
      Write-Host "A migration wouldn't revert, so the new code stays. The safety dump is in data\backups."
      # Those reverted before it must come back, or the new code won't start on this database
      # either (the services refuse a database that doesn't fit them).
      Write-Host "== Migrating the database again, for the code that stays"
      pnpm --silent hearth migrate | Out-Host
      if ($LASTEXITCODE -ne 0) {
        Write-Host "That failed too, so Hearth can't start until the safety dump is restored (docs\setup-windows.md)."
      }
    }
  }
  if ($stopped) {
    # Hearth was stopped above, maybe only seconds ago: no margin, so only the restart counts.
    $since = [datetime]::UtcNow
    # An older Jarvis that wouldn't stop is left running, as it was before the update: its task
    # couldn't start another, and waiting three minutes to find that out would say less.
    $restart = Get-RollbackParts
    try { Start-Hearth $restart.Parts } catch { Write-Host "Couldn't start Hearth again: $_" }
    $running = (git rev-parse HEAD).Trim()
    $why = Wait-Hearth -Since $since -Sha $running -Parts $restart.Parts -TimeoutSec $HealthTimeoutSec -AllowOld `
      -Failed (Get-FailingChecks $before)
    if ($why) {
      Write-Host "HEARTH ISN'T BACK UP on $(Format-Sha $running): $why. Run pnpm hearth doctor to see why."
    } elseif ($restart.Stuck) {
      Write-Host "== Hearth is back up on $(Format-Sha $running), with Jarvis left as it was. $($restart.Stuck)."
    } else {
      Write-Host "== Hearth is back up on $(Format-Sha $running)."
    }
  }
} finally {
  if ($lock) { $lock.Dispose() }
  try { [Console]::OutputEncoding = $consoleEncoding } catch {}
  try { Stop-Transcript | Out-Null } catch {}
}
exit $exit
