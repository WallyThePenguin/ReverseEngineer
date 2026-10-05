<#
  Stopping, starting and checking Hearth, shared by update.ps1 and restart.ps1, which dot-source
  this file; it only defines functions. They run unelevated once install.ps1 has given your
  account the rights to Hearth's two services and the "Hearth Jarvis" task. They read $Root, the
  Hearth folder, from the script that dot-sources them.
#>

function Get-EnvValue([string]$Name) {
  if (-not (Test-Path "$Root\.env")) { return $null }
  $line = Get-Content "$Root\.env" | Where-Object { $_ -match "^$Name=" } | Select-Object -First 1
  if ($line) { return ($line -replace "^$Name=", "").Trim() }
  return $null
}

function Get-HearthPort {
  $port = Get-EnvValue "HEARTH_PORT"
  if ($port) { return $port }
  return "4400"
}

# Which of server, worker and jarvis a name means.
function Resolve-HearthParts([string]$Which) {
  if ($Which -eq "all") { return @("server", "worker", "jarvis") }
  return @($Which)
}

# When $Proc started. Your unelevated account may not open the task's Jarvis to ask (it runs in
# the task's own logon session), but Windows' process list (WMI) still says. $null if neither does.
function Get-StartTime($Proc) {
  try { $started = $Proc.StartTime } catch { $started = $null }
  if ($started) { return $started }
  try {
    $listed = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$Proc.Id)" -ErrorAction Stop
    if ($listed) { return $listed.CreationDate }
  } catch {}
  return $null
}

# Whether $Proc is the Jarvis that wrote its pid file at $Written. The file outlives a Jarvis that
# was killed or crashed, and Windows reuses pids; a process that got the pid later started after
# the file was written, so it isn't Jarvis. One whose start time can't be read isn't trusted.
function Test-JarvisPid($Proc, [datetime]$Written) {
  if (-not $Proc -or $Proc.ProcessName -ne "node") { return $false }
  $started = Get-StartTime $Proc
  return $null -ne $started -and $started -le $Written.AddSeconds(5)
}

# The Jarvis processes running now. An unelevated account can't read session-0 command lines, so:
# the pid Jarvis wrote at startup, plus every node under a running instance of its task.
function Find-Jarvis {
  $pids = @()
  $pidFile = "$env:ProgramData\Hearth\services\hearth-jarvis.pid"
  if (Test-Path $pidFile) {
    $proc = Get-Process -Id ([int](Get-Content $pidFile -Raw).Trim()) -ErrorAction SilentlyContinue
    if (Test-JarvisPid $proc (Get-Item $pidFile).LastWriteTime) { $pids += $proc.Id }
  }
  $scheduler = New-Object -ComObject Schedule.Service
  $scheduler.Connect()
  $task = $scheduler.GetFolder("\").GetTask("Hearth Jarvis")
  foreach ($run in @($task.GetInstances(0))) {
    $pids += @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($run.EnginePID)" |
      Where-Object { $_.Name -eq "node.exe" } | ForEach-Object { $_.ProcessId })
  }
  return @($pids | Select-Object -Unique)
}

# Which of $Pids are still a running node after up to $TimeoutSec.
function Wait-JarvisGone([int[]]$Pids, [int]$TimeoutSec) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ($true) {
    $left = @($Pids | Where-Object { (Get-Process -Id $_ -ErrorAction SilentlyContinue).ProcessName -eq "node" })
    if (-not $left.Count -or (Get-Date) -ge $deadline) { return $left }
    Start-Sleep -Milliseconds 500
  }
}

# What to say about a Jarvis that won't stop. While it runs, the task can't start another: cmd
# can't open the log that Jarvis still holds, so each start fails at once and logs nothing.
function Get-JarvisLeftMessage([int[]]$Left) {
  return "Jarvis (pid $($Left -join ', ')) is still running, on the code it started with, and this account can't stop it. " +
    "While it runs, the Hearth Jarvis task can't start a new one. From an elevated PowerShell, run: " +
    "Stop-Process -Id $($Left -join ',') -Force; then try again."
}

function Stop-Jarvis([int]$TimeoutSec = 40) {
  $pids = @(Find-Jarvis)
  # Stopping the task ends cmd, and Jarvis stops itself within seconds of that
  # (apps/jarvis/src/main.ts): your unelevated account can't end the task's processes itself.
  # Elevated it can, which also ends a Jarvis from before Jarvis did that.
  Stop-ScheduledTask -TaskName "Hearth Jarvis" -ErrorAction SilentlyContinue
  foreach ($p in $pids) {
    try { Stop-Process -Id $p -Force -ErrorAction Stop } catch {}
  }
  $null = Wait-TaskStopped "Hearth Jarvis"
  # Up to the CLI's 15 seconds to stop, after the 2 it takes to notice.
  $left = @(Wait-JarvisGone $pids $TimeoutSec)
  if ($left.Count) { throw (Get-JarvisLeftMessage $left) }
}

# Until Windows no longer counts a task as running, up to $TimeoutSec. The task ignores a start
# while a run is still counted (IgnoreNew), so `hearth restart jarvis`, which starts it again
# straight away, would otherwise leave Jarvis off.
function Wait-TaskStopped([string]$Name, [int]$TimeoutSec = 15) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    if (-not $task -or "$($task.State)" -ne "Running") { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Stop-Hearth([string[]]$Parts = @("server", "worker", "jarvis")) {
  Write-Host "== Stopping Hearth ($($Parts -join ', '))"
  if ($Parts -contains "jarvis") { Stop-Jarvis }
  $services = @($Parts | Where-Object { $_ -ne "jarvis" } | ForEach-Object { "hearth-$_" })
  if ($services.Count) { Stop-Service $services }
}

function Start-Hearth([string[]]$Parts = @("server", "worker", "jarvis")) {
  Write-Host "== Starting Hearth ($($Parts -join ', '))"
  $services = @($Parts | Where-Object { $_ -ne "jarvis" } | ForEach-Object { "hearth-$_" })
  if ($services.Count) { Start-Service $services }
  if ($Parts -contains "jarvis") {
    # One Jarvis at a time, and a start would fail on the log an old one holds anyway.
    $left = @(Find-Jarvis)
    if ($left.Count) { throw (Get-JarvisLeftMessage $left) }
    Start-ScheduledTask -TaskName "Hearth Jarvis"
  }
}

# Waits for the server to answer /api/health, up to a minute.
function Test-Hearth {
  $port = Get-HearthPort
  for ($i = 0; $i -lt 30; $i++) {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 "http://127.0.0.1:$port/api/health"
      if ($r.StatusCode -eq 200) { return $true }
    } catch {}
    Start-Sleep -Seconds 2
  }
  return $false
}

# The server's own report (GET /api/health/deep, which answers programs on this PC). Status is the
# HTTP status, 0 when it doesn't answer; Body the report when it's 200.
function Get-DeepHealth {
  try {
    $body = Invoke-RestMethod -UseBasicParsing -TimeoutSec 5 "http://127.0.0.1:$(Get-HearthPort)/api/health/deep"
    return [pscustomobject]@{ Status = 200; Body = $body }
  } catch {
    $code = 0
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    return [pscustomobject]@{ Status = $code; Body = $null }
  }
}

function ConvertTo-UtcTime($Value) {
  if ($null -eq $Value -or "$Value" -eq "") { return [datetime]::MinValue }
  if ($Value -is [datetime]) { return $Value.ToUniversalTime() }
  return [datetime]::Parse([string]$Value, [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::AdjustToUniversal)
}

function Format-Sha([string]$Sha) {
  if ($Sha -and $Sha.Length -ge 7) { return $Sha.Substring(0, 7) }
  return "an unknown build"
}

# What's still wrong with a deep health report, or $null once everything in $Parts is up: the
# server on $Sha (when given) with its database fitting the code, started after $Since, and the
# worker and Jarvis reporting in since $Since, not failing. Those in $Failed were failing already
# before the restart: they only have to report in. (Jarvis's health says how its last turn went,
# which a restart doesn't change, so requiring "not failing" would roll back the very update that
# fixes its turns.)
function Get-DeepProblem($Deep, [datetime]$Since, [string]$Sha, [string[]]$Parts, [string[]]$Failed = @()) {
  if ($Parts -contains "server") {
    if ($Sha -and $Deep.sha -ne $Sha) {
      return "the server runs $(Format-Sha $Deep.sha), not $(Format-Sha $Sha)"
    }
    if (-not $Deep.db -or -not $Deep.db.ok) { return "the server can't reach the database" }
    if (-not $Deep.migrations -or -not $Deep.migrations.ok) {
      return "the database doesn't fit the code ($($Deep.problems -join '; '))"
    }
    if ((ConvertTo-UtcTime $Deep.startedAt) -lt $Since) { return "the server hasn't restarted" }
  }
  foreach ($part in @("worker", "jarvis")) {
    if ($Parts -notcontains $part) { continue }
    $c = $Deep.components.$part
    if (-not $c -or (ConvertTo-UtcTime $c.at) -lt $Since) { return "the $part hasn't reported in since it started" }
    # The jarvis component can be the worker saying Jarvis hasn't checked in; only a running
    # Jarvis writes jarvisAlive, and its since says when that Jarvis started, so one the stop
    # missed (still on the old code) doesn't count either. (A server from before jarvisAlive,
    # gone back to, doesn't say.)
    if ($part -eq "jarvis" -and $Deep.PSObject.Properties["jarvisAlive"] -and
      (ConvertTo-UtcTime $Deep.jarvisAlive.since) -lt $Since) {
      return "Jarvis hasn't checked in since it started"
    }
    if ($c.status -eq "failing" -and $Failed -notcontains $part) { return "the $part says: $($c.detail)" }
  }
  return $null
}

# Which of the worker and Jarvis were failing in a deep health report (before a restart).
function Get-FailingParts($Deep) {
  if (-not $Deep -or -not $Deep.components) { return @() }
  return @(@("worker", "jarvis") | Where-Object { $Deep.components.$_ -and $Deep.components.$_.status -eq "failing" })
}

# The same from a doctor report (before an update; the doctor before deep health had them too).
function Get-FailingChecks($Report) {
  return @(@("worker", "jarvis") | Where-Object { (Get-DoctorMark $Report $_) -eq "fail" })
}

# Waits until Get-DeepProblem finds nothing; returns $null then, or the last problem when time's
# up. -AllowOld accepts a server from before deep health (it answers 404): going back to old code.
function Wait-Hearth {
  param(
    [datetime]$Since,
    [string]$Sha = "",
    [string[]]$Parts = @("server", "worker", "jarvis"),
    [int]$TimeoutSec = 180,
    [string[]]$Failed = @(),
    [switch]$AllowOld
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $why = "the server isn't answering"
  while ($true) {
    $deep = Get-DeepHealth
    if ($deep.Status -eq 200) {
      $why = Get-DeepProblem $deep.Body $Since $Sha $Parts $Failed
      if (-not $why) { return $null }
    } elseif ($deep.Status -eq 404) {
      if ($AllowOld) { return $null }
      $why = "the server is still the old one (no /api/health/deep)"
    } elseif ($deep.Status) {
      $why = "the server answers HTTP $($deep.Status)"
    }
    if ((Get-Date) -ge $deadline) { return $why }
    Start-Sleep -Seconds 3
  }
}

# When a Jarvis started after $Since (UTC) checked in, or $null if none has within $TimeoutSec: its
# pid file, written once it's running, or the server's word (jarvisAlive). On a busy PC Jarvis can
# take minutes to start, so one look after a few seconds would call a slow start a failed one.
function Wait-JarvisCheckIn([datetime]$Since, [string]$PidFile, [int]$TimeoutSec = 180) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ($true) {
    $file = Get-Item $PidFile -ErrorAction SilentlyContinue
    if ($file -and $file.LastWriteTimeUtc -ge $Since) { return $file.LastWriteTimeUtc }
    $deep = Get-DeepHealth
    if ($deep.Status -eq 200 -and $deep.Body.jarvisAlive) {
      $at = ConvertTo-UtcTime $deep.Body.jarvisAlive.since
      if ($at -ge $Since) { return $at }
    }
    if ((Get-Date) -ge $deadline) { return $null }
    Start-Sleep -Seconds 2
  }
}

# `hearth doctor`'s checks: Checks from --json, or, from a doctor before --json, its Text.
function Get-DoctorReport {
  $out = pnpm --silent hearth doctor --json | Out-String
  try { $json = $out | ConvertFrom-Json } catch { $json = $null }
  if ($json -and $null -ne $json.checks) { return [pscustomobject]@{ Checks = @($json.checks); Text = $null } }
  return [pscustomobject]@{ Checks = $null; Text = $out }
}

# How a check came out in an earlier doctor report: ok, warn, fail, or $null if it wasn't there.
# Names match exactly ("Server" the HTTP check isn't "server" the component); should two checks
# share a name, the worse mark counts, so a failure from before is never taken for a new one.
function Get-DoctorMark($Report, [string]$Name) {
  if (-not $Report) { return $null }
  if ($Report.Checks) {
    $marks = @($Report.Checks | Where-Object { $_.name -ceq $Name } | ForEach-Object { $_.mark })
    foreach ($m in @("fail", "warn", "ok")) { if ($marks -contains $m) { return $m } }
    return $null
  }
  # The text doctor prints "<mark> <name, padded> <detail>": a check mark (U+2713) for ok, ! for
  # warn, a cross (U+2717) for fail. Needs the console reading UTF-8 (update.ps1 sets it).
  foreach ($line in ("$($Report.Text)" -split "`r?`n")) {
    if ($line.Length -lt 3 -or -not $line.Substring(2).StartsWith("$Name ")) { continue }
    if ($line[0] -eq [char]0x2713) { return "ok" }
    if ($line[0] -eq "!") { return "warn" }
    if ($line[0] -eq [char]0x2717) { return "fail" }
  }
  return $null
}

# Sorts what fails after an update: New failed after but not before (the update broke it), Old
# failed before too, Unknown is a check the doctor before didn't have, so it can't tell.
function Compare-Doctor($Before, $After) {
  $result = [pscustomobject]@{ New = @(); Old = @(); Unknown = @() }
  foreach ($c in @($After.Checks | Where-Object { $_.mark -eq "fail" })) {
    $was = Get-DoctorMark $Before $c.name
    if ($was -eq "fail") { $result.Old += $c }
    elseif ($was) { $result.New += $c }
    else { $result.Unknown += $c }
  }
  return $result
}

# The migrations `hearth migrate` printed as applied, oldest first. It prints them even when a
# later one fails: each commits on its own, so a rollback has to revert them.
function Get-AppliedMigrations([string]$Out) {
  if ($Out -match "Applied: (.+)") { return @($Matches[1].Trim() -split ",\s*") }
  return @()
}

# Reverts the migrations an update applied, newest first, each by name: the newest in the
# database isn't always this update's (a lower number can arrive after a higher one). True when
# every one reverted; it stops at the first that won't.
function Undo-Migrations([string[]]$Applied) {
  for ($i = $Applied.Count - 1; $i -ge 0; $i--) {
    Write-Host "== Reverting migration $($Applied[$i])"
    pnpm --silent hearth migrate down $Applied[$i] | Out-Host
    if ($LASTEXITCODE -ne 0) { return $false }
  }
  return $true
}

# The arguments that run the updated update.ps1 ($Script) to carry on an update: the parameters
# this run was given ($Bound, its $PSBoundParameters), with -Root and -Relaunched.
function Get-RelaunchArgs($Bound, [string]$Script, [string]$Root) {
  $list = @("-NoProfile", "-File", $Script, "-Root", $Root)
  foreach ($p in $Bound.GetEnumerator()) {
    if ($p.Key -in "Root", "Relaunched") { continue }
    if ($p.Value -is [switch]) {
      if ($p.Value.IsPresent) { $list += "-$($p.Key)" }
    } else {
      $list += "-$($p.Key)", "$($p.Value)"
    }
  }
  return $list + "-Relaunched"
}

# Hands an update over to its updated update.ps1 (& $Exe $Arguments), which reads $State from
# $Handover and deletes it before it carries on. Sets $ExitCode to its exit code. Throws when it
# never took over (the file is still there), so the rollback of the run that called this applies.
# Called as a statement, so the new update.ps1 writes straight to this window.
function Invoke-Handover([string]$Exe, [string[]]$Arguments, $State, [string]$Handover, [ref]$ExitCode) {
  $State | Export-Clixml -Depth 5 -Path $Handover
  & $Exe @Arguments
  $code = $LASTEXITCODE
  if (Test-Path $Handover) {
    Remove-Item $Handover
    throw "The updated update.ps1 didn't start (exit $code)"
  }
  $ExitCode.Value = $code
}
