<#
  Finding, stopping and waiting for Jarvis (D63), the "Hearth Jarvis" task. Part of control.ps1,
  which dot-sources this file (update.ps1, restart.ps1 and install.ps1 dot-source control.ps1);
  it only defines functions. Tested with control.ps1's tests (test-control-jarvis.ps1).
#>

# Hearth's services folder: the services' logs, and Jarvis's log, pid file and stop request.
function Get-ServiceDir { return "$env:ProgramData\Hearth\services" }

# When process $Id started, from Windows' process list (WMI), or $null when there's no such
# process or Windows won't say.
function Get-ProcessStart([int]$Id) {
  try { return (Get-CimInstance Win32_Process -Filter "ProcessId = $Id" -ErrorAction Stop).CreationDate } catch { return $null }
}

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
# session-0 command lines). Verified says it's surely Jarvis; Started, when Windows says, tells it
# from a process that gets its pid later (Test-StillJarvis).
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
  return @($found.Keys | ForEach-Object {
      [pscustomobject]@{ Id = $_; Verified = $found[$_]; Started = Get-ProcessStart $_ }
    })
}

# Whether $J, from Find-Jarvis, is still running: still a node.exe, and when Windows said when it
# started, still that process. Windows hands a pid on, and a later process isn't Jarvis to name.
function Test-StillJarvis($J) {
  $proc = Get-Process -Id $J.Id -ErrorAction SilentlyContinue
  if (-not $proc -or $proc.ProcessName -ne "node") { return $false }
  return -not $J.Started -or (Get-ProcessStart $J.Id) -eq $J.Started
}

# Asks Jarvis to stop (D63): it checks for this file every second, and stops for one newer than
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

# Removes a request left from an earlier stop, before Jarvis is started again. Jarvis removes the
# one it stops for, and ignores one older than itself; but one it couldn't remove (an
# administrator's) would stop the next Jarvis should the clock step back.
function Clear-JarvisStopRequest([string]$Dir) {
  Remove-Item -LiteralPath "$Dir\hearth-jarvis.stop" -Force -ErrorAction SilentlyContinue
}

# Whether the task could open Jarvis's log now. Its cmd.exe opens the log for append before it
# starts node, and every Jarvis it started keeps it open; while one does, the next task run's cmd
# exits 1 at once, with nothing logged (2026-10-05).
function Test-LogFree([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $true }
  try { [IO.File]::Open($Path, "Append", "Write", "ReadWrite").Dispose(); return $true } catch { return $false }
}

# Only an administrator can end a Jarvis that won't stop. (Restarting the PC isn't offered: when
# the Hearth you update from predates D63, its update leaves the restarted Jarvis running too.)
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

# Checks every half second until Jarvis has stopped, or $Sec seconds have passed: $null then, or
# what's wrong. By the clock, not by counting checks: each asks Windows when a process started,
# which took 390 ms on a busy PC, and counting checks made a 10 s wait take 19 (2026-10-05).
function Wait-JarvisGone($Found, [string]$Log, [int]$Sec) {
  $deadline = (Get-Date).AddSeconds($Sec)
  while ($true) {
    $alive = @($Found | Where-Object { Test-StillJarvis $_ })
    $why = Get-JarvisVerdict $alive (Test-LogFree $Log) $Log
    if (-not $why) { return $null }
    $left = ($deadline - (Get-Date)).TotalMilliseconds
    if ($left -le 0) { return $why }
    Start-Sleep -Milliseconds ([Math]::Min(500, [Math]::Ceiling($left)))
  }
}

# Stops Jarvis: $null once it has, otherwise what to tell you, and Hearth mustn't start another
# (the task can't while the old one holds the log). Your unelevated account can neither end the
# task's Jarvis nor read its start time, so it asks Jarvis (Request-JarvisStop) and ends the task
# run, which a Jarvis since D63 also stops for. After $AskSec it ends what it's sure is Jarvis,
# which works when this runs elevated. A Jarvis from before D63 ignores both: the update that
# brings D63 can only say so, with the pid to end. $AskSec is the longest a Jarvis since D63 can
# take once asked: a second to notice, 20 to learn who asked (stop-request.ts), 12 to stop
# (apps/jarvis/src/main.ts), with time to spare; test-control-jarvis.ps1 checks they agree.
function Stop-Jarvis([int]$AskSec = 40, [int]$KillSec = 15) {
  $dir = Get-ServiceDir
  $log = "$dir\hearth-jarvis.log"
  # Before the task stops: its children are found through it.
  $found = @(Find-Jarvis $dir)
  Request-JarvisStop $dir
  Stop-ScheduledTask -TaskName "Hearth Jarvis" -ErrorAction SilentlyContinue
  $why = Wait-JarvisGone $found $log $AskSec
  if ($why) {
    foreach ($j in @($found | Where-Object { $_.Verified })) {
      if (Test-StillJarvis $j) { Stop-Process -Id $j.Id -Force -ErrorAction SilentlyContinue }
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
# stop holds its log (its task can't start another), with why. Should Windows not say, Jarvis is
# left out too: Start-Hearth would refuse to start anything without knowing.
function Get-RollbackParts {
  try { $stuck = Get-StuckJarvis } catch { $stuck = "Hearth couldn't tell whether Jarvis has stopped ($_), so it wasn't started again" }
  if ($stuck) { return [pscustomobject]@{ Parts = @("server", "worker"); Stuck = $stuck } }
  return [pscustomobject]@{ Parts = @("server", "worker", "jarvis"); Stuck = $null }
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
