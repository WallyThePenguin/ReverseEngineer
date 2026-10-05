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

# Hearth's services folder: the services' logs, and Jarvis's log, pid file and stop request.
function Get-ServiceDir { return "$env:ProgramData\Hearth\services" }

# Whether $Proc is the Jarvis that wrote its pid file at $Written: "jarvis" when it is, $null when
# it isn't, "unverified" when it's a node.exe whose start time Windows won't tell this account.
# The file outlives a Jarvis that was killed or crashed, and Windows reuses pids; a process that
# got the pid later started after the file was written, so it isn't Jarvis. But the task's Jarvis
# runs in session 0, and from your unelevated account its start time comes back blank
# (2026-10-05): it may well be Jarvis, so it's neither ended nor taken for stopped.
function Resolve-JarvisPid($Proc, [datetime]$Written) {
  if (-not $Proc -or $Proc.ProcessName -ne "node") { return $null }
  try { $started = $Proc.StartTime } catch { return "unverified" }
  if ($null -eq $started) { return "unverified" }
  if ($started -le $Written.AddSeconds(5)) { return "jarvis" }
  return $null
}

# The processes that may be Jarvis: the pid Jarvis wrote at startup, and every node child of the
# task's running process (Jarvis runs under cmd in the task, and an unelevated account can't read
# session-0 command lines). Verified says it's surely Jarvis.
function Find-Jarvis([string]$Dir) {
  $found = @{}
  $pidFile = "$Dir\hearth-jarvis.pid"
  $id = 0
  if ((Test-Path $pidFile) -and [int]::TryParse("$(Get-Content $pidFile -Raw)".Trim(), [ref]$id)) {
    $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
    $kind = Resolve-JarvisPid $proc (Get-Item $pidFile).LastWriteTime
    if ($kind) { $found[$id] = $kind -eq "jarvis" }
  }
  $scheduler = New-Object -ComObject Schedule.Service
  $scheduler.Connect()
  $task = $scheduler.GetFolder("\").GetTask("Hearth Jarvis")
  foreach ($run in @($task.GetInstances(0))) {
    Get-CimInstance Win32_Process -Filter "ParentProcessId = $($run.EnginePID)" |
      Where-Object { $_.Name -eq "node.exe" } | ForEach-Object { $found[[int]$_.ProcessId] = $true }
  }
  return @($found.Keys | ForEach-Object { [pscustomobject]@{ Id = $_; Verified = $found[$_] } })
}

# Asks Jarvis to stop (D62): it checks for this file every second, and stops for one newer than
# itself that's yours or an administrator's (apps/jarvis/src/stop-request.ts). Made afresh, so the
# file is yours whoever made it first.
function Request-JarvisStop([string]$Dir) {
  if (-not (Test-Path $Dir)) { return }
  $file = "$Dir\hearth-jarvis.stop"
  try {
    Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
    [IO.File]::WriteAllText($file, [datetime]::UtcNow.ToString("o"))
  } catch {
    Write-Warning "Couldn't ask Jarvis to stop ($file): $($_.Exception.Message)"
  }
}

# Whether the task could open Jarvis's log now. Its cmd.exe opens the log for append before it
# starts node, and every Jarvis it started keeps it open; while one does, the next task run's cmd
# exits 1 at once, with nothing logged (2026-10-05).
function Test-LogFree([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $true }
  try { [IO.File]::Open($Path, "Append", "Write", "ReadWrite").Dispose(); return $true } catch { return $false }
}

# Only an administrator can end a Jarvis that won't stop. (Restarting the PC isn't offered: when
# the Hearth you update from predates D62, its update leaves the restarted Jarvis running too.)
function Format-StuckJarvis([int[]]$Ids) {
  $which = if ($Ids.Count -gt 1) { "pids $($Ids -join ', ')" } else { "pid $Ids" }
  $kill = ($Ids | ForEach-Object { "/PID $_" }) -join " "
  return "An older Jarvis ($which) is still running and Hearth can't stop it from your account: run taskkill /F $kill as administrator, then try again right away"
}

# Whether Jarvis has stopped: $null when it has, otherwise what to tell you. $Alive are those of
# Find-Jarvis still running. A held log means a Jarvis is still running even when this account
# can't tell which; an unverified pid still there while the log is free is some other node.exe
# that got Jarvis's old pid.
function Get-JarvisVerdict($Alive, [bool]$LogFree, [string]$Log) {
  $sure = @($Alive | Where-Object { $_.Verified } | ForEach-Object { $_.Id })
  if ($sure.Count) { return Format-StuckJarvis $sure }
  if ($LogFree) { return $null }
  $maybe = @($Alive | ForEach-Object { $_.Id })
  if ($maybe.Count) { return Format-StuckJarvis $maybe }
  return "Something still holds Jarvis's log ($Log) open, most likely an older Jarvis that Hearth can't stop or name from your account: end it as administrator (Task Manager, Details: the node.exe in session 0 running as you), then try again right away"
}

# Checks every half second, up to $Sec, until Jarvis has stopped: $null then, or what's wrong.
function Wait-JarvisGone($Found, [string]$Log, [int]$Sec) {
  for ($i = 0; ; $i++) {
    $alive = @($Found | Where-Object { Get-Process -Id $_.Id -ErrorAction SilentlyContinue })
    $why = Get-JarvisVerdict $alive (Test-LogFree $Log) $Log
    if (-not $why -or $i -ge $Sec * 2) { return $why }
    Start-Sleep -Milliseconds 500
  }
}

# Stops Jarvis: $null once it has, otherwise what to tell you, and Hearth mustn't start another
# (the task can't while the old one holds the log). Your unelevated account can neither end the
# task's Jarvis nor read its start time, so it asks Jarvis (Request-JarvisStop) and ends the task
# run, which a Jarvis since D62 also stops for. After $AskSec it ends what it's sure is Jarvis,
# which works when this runs elevated. A Jarvis from before D62 ignores both: the update that
# brings D62 can only say so, with the pid to end.
function Stop-Jarvis([int]$AskSec = 15, [int]$KillSec = 15) {
  $dir = Get-ServiceDir
  $log = "$dir\hearth-jarvis.log"
  # Before the task stops: its children are found through it.
  $found = @(Find-Jarvis $dir)
  Request-JarvisStop $dir
  Stop-ScheduledTask -TaskName "Hearth Jarvis" -ErrorAction SilentlyContinue
  $why = Wait-JarvisGone $found $log $AskSec
  if ($why) {
    foreach ($j in @($found | Where-Object { $_.Verified })) {
      $proc = Get-Process -Id $j.Id -ErrorAction SilentlyContinue
      if ($proc -and $proc.ProcessName -eq "node") { Stop-Process -Id $j.Id -Force -ErrorAction SilentlyContinue }
    }
    $why = Wait-JarvisGone $found $log $KillSec
  }
  $null = Wait-TaskStopped "Hearth Jarvis"
  return $why
}

# A Jarvis an earlier Stop-Jarvis couldn't stop, as what to tell you, or $null.
function Get-StuckJarvis {
  $dir = Get-ServiceDir
  return Wait-JarvisGone @(Find-Jarvis $dir) "$dir\hearth-jarvis.log" 0
}

# What a rollback starts again: all of Hearth, or all but Jarvis while an older one that wouldn't
# stop holds its log (its task can't start another), with why.
function Get-RollbackParts {
  $stuck = Get-StuckJarvis
  if ($stuck) { return [pscustomobject]@{ Parts = @("server", "worker"); Stuck = $stuck } }
  return [pscustomobject]@{ Parts = @("server", "worker", "jarvis"); Stuck = $null }
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

# Jarvis first: one that won't stop throws, leaving the rest as it was, unless -Anyway (a rollback
# has to stop the rest whatever Jarvis does).
function Stop-Hearth([string[]]$Parts = @("server", "worker", "jarvis"), [switch]$Anyway) {
  Write-Host "== Stopping Hearth ($($Parts -join ', '))"
  $stuck = $null
  if ($Parts -contains "jarvis") { $stuck = Stop-Jarvis }
  if ($stuck -and -not $Anyway) { throw "$stuck." }
  if ($stuck) { Write-Host "$stuck." }
  $services = @($Parts | Where-Object { $_ -ne "jarvis" } | ForEach-Object { "hearth-$_" })
  if ($services.Count) { Stop-Service $services }
}

function Start-Hearth([string[]]$Parts = @("server", "worker", "jarvis")) {
  Write-Host "== Starting Hearth ($($Parts -join ', '))"
  $services = @($Parts | Where-Object { $_ -ne "jarvis" } | ForEach-Object { "hearth-$_" })
  if ($services.Count) { Start-Service $services }
  if ($Parts -contains "jarvis") { Start-ScheduledTask -TaskName "Hearth Jarvis" }
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
    # missed (still on the old code) doesn't count either. One that has checked in since the
    # restart is that one, still running, and the new one can't start while it holds the log:
    # named, so you know what to end (2026-10-05). (A server from before jarvisAlive, gone back
    # to, doesn't say.)
    if ($part -eq "jarvis" -and $Deep.PSObject.Properties["jarvisAlive"] -and
      (ConvertTo-UtcTime $Deep.jarvisAlive.since) -lt $Since) {
      if ($Deep.jarvisAlive.pid -and (ConvertTo-UtcTime $Deep.jarvisAlive.at) -ge $Since) {
        return Format-StuckJarvis @([int]$Deep.jarvisAlive.pid)
      }
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
