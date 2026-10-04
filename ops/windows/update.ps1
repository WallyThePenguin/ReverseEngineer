<#
.SYNOPSIS
  Updates Hearth in place, from your own account: no administrator needed.

.DESCRIPTION
  install.ps1 lets your account stop and start Hearth's two services and the "Hearth Jarvis" task,
  so this runs unelevated. It asks hearth doctor how things are, takes a safety dump, stops Hearth,
  moves to the latest commit of the branch, installs, builds, migrates and starts everything again.
  Then the update has to prove itself (D57), or it's rolled back:

  - The server reports the new commit through /api/health/deep, its database has every migration
    the new code expects, and the worker and Jarvis report in after the restart, not failing.
    Within three minutes.
  - When scripts\probe-jarvis-tools.ts exists, it passes (exit 0). That's the hook for the Jarvis
    tool-schema probe: it sends Jarvis's whole tool list to the model in one small call, so a tool
    the API rejects stops the update instead of every Jarvis turn.
  - hearth doctor finds nothing failing that wasn't failing before the update. What already failed
    (a full disk, say) is listed but doesn't block a fix; a check the old doctor didn't have can't
    be compared, so it's listed as a warning.

  Rolling back reverts the migrations this update applied (`hearth migrate down`, newest first),
  puts the previous code back, starts it and checks that it came back. Should a migration not
  revert, the new code stays and the safety dump in data\backups is the way back.

  When the update changes the service definitions or install.ps1, it says to run install.ps1
  again as administrator; everything else still updates.

  Log: data\logs\update-<date>.log, one per day, appended. Exit code 0 means Hearth is up and
  healthy on the new code.
#>
[CmdletBinding()]
param(
  [string]$Root = (Resolve-Path "$PSScriptRoot\..\..").Path,
  [string]$Branch = "claude/admiring-wright-ghc2o3",
  # Run every step even when already on the latest commit.
  [switch]$Force,
  # The optional Jarvis tool-schema probe, relative to $Root (see above).
  [string]$JarvisProbe = "scripts\probe-jarvis-tools.ts",
  # How long the new code gets to report in healthy.
  [int]$HealthTimeoutSec = 180
)
$ErrorActionPreference = "Stop"
Set-Location $Root
. "$PSScriptRoot\control.ps1"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
New-Item -ItemType Directory -Force "$Root\data\logs", "$Root\data\backups" | Out-Null
Start-Transcript -Append -Path "$Root\data\logs\update-$(Get-Date -Format yyyy-MM-dd).log" | Out-Null
# hearth doctor writes UTF-8; read it as UTF-8 (for this window only, put back at the end).
$consoleEncoding = [Console]::OutputEncoding
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

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

function Write-Doctor($Report) {
  foreach ($c in $Report.Checks) { Write-Host ("{0,-5} {1,-14} {2}" -f $c.mark, $c.name, $c.detail) }
}

# The new code must prove itself: deep health, the Jarvis probe if there is one, then the doctor.
function Assert-Healthy([string]$Sha, [datetime]$Since, $Before) {
  Write-Host "== Waiting for Hearth to report in on $(Format-Sha $Sha)"
  $why = Wait-Hearth -Since $Since -Sha $Sha -TimeoutSec $HealthTimeoutSec
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

  Write-Host "== Asking hearth doctor how things are before the update"
  $before = Get-DoctorReport
  if ($before.Checks) { Write-Doctor $before } else { Write-Host $before.Text }

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
  $since = [datetime]::UtcNow.AddSeconds(-5)
  Start-Hearth
  $stopped = $false
  Assert-Healthy $new $since $before
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
    $since = [datetime]::UtcNow.AddSeconds(-5)
    try { Start-Hearth } catch { Write-Host "Couldn't start Hearth again: $_" }
    $running = (git rev-parse HEAD).Trim()
    $why = Wait-Hearth -Since $since -Sha $running -TimeoutSec $HealthTimeoutSec -AllowOld
    if ($why) {
      Write-Host "HEARTH ISN'T BACK UP on $(Format-Sha $running): $why. Run pnpm hearth doctor to see why."
    } else {
      Write-Host "== Hearth is back up on $(Format-Sha $running)."
    }
  }
} finally {
  $lock.Dispose()
  try { [Console]::OutputEncoding = $consoleEncoding } catch {}
  Stop-Transcript | Out-Null
}
exit $exit
