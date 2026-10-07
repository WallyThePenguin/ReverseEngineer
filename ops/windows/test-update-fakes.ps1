<#
  Runs the real update.ps1 with everything it would touch faked: git, pnpm, pg_dump, Hearth's
  services, Jarvis's task and processes, and the server's health. Only test-control-update.ps1
  runs this, each case in a Windows PowerShell of its own, and reads what happened from
  $Work\events.txt. ProgramData and Hearth's folder are in $Work, and it refuses to run update.ps1
  until every command that could reach a real Hearth on this PC is one of these fakes.

  Hearth starts on commit 1111111 (old), with its services up and a Jarvis since D63 (it stops
  with its task run) under the task. The update goes to 2222222 (new). -Case says what goes wrong:
    leftover       a Jarvis from before D63 starts while the update installs (the task's sign-in
                   trigger, say) and holds its log: Start-Hearth must refuse before anything starts
    service-fails  hearth-worker won't start on the new code, after hearth-server has
    jarvis-throws  the new code isn't healthy, and stopping Jarvis then fails outright
    stuck-first    a Jarvis from before D63 is running when the update stops Hearth, so the stop
                   fails before the services: nothing is down, and nothing must be waited for
    worker-stop-fails  hearth-worker won't stop, after hearth-server has: only what's down starts
  force-leftover and force-service-fails are the first two with -Force on the commit Hearth is
  already on: nothing to roll back, but Hearth must start again (hearth-worker never will there).

  Time is faked too: Get-Date reads a clock that only Start-Sleep moves, so a wait ends at once,
  once the time it was given has passed on that clock.
#>
param(
  [Parameter(Mandatory = $true)][string]$Work,
  [Parameter(Mandatory = $true)]
  [ValidateSet("leftover", "service-fails", "jarvis-throws", "stuck-first", "worker-stop-fails", "force-leftover",
    "force-service-fails")][string]$Case
)
$ErrorActionPreference = "Stop"
if (-not (Test-Path "$Work\fake-update")) { throw "Only test-control-update.ps1 runs this." }
# Jarvis's log, pid file and stop request go here, never in the real services folder.
$env:ProgramData = "$Work\ProgramData"
$global:dir = "$env:ProgramData\Hearth\services"
$force = $Case -like "force-*"
$global:case = $Case -replace "^force-", ""
$global:old = "1111111111111111111111111111111111111111"
$global:new = $(if ($force) { $global:old } else { "2222222222222222222222222222222222222222" })
$global:head = $global:old
$global:running = @{}
# When each service last started, as the server's health says for itself.
$global:started = @{}
$global:jarvis = @{}
$global:taskOn = $false
$global:held = $null
$global:schedulerDown = $false
$global:sleeps = 0
$global:clock = [datetime]::Now

# What happened, with the services running then and the commit each runs.
function global:Write-Event([string]$What) {
  $on = @($global:running.Keys | Sort-Object | ForEach-Object { "$_@$($global:running[$_].Substring(0, 1))" }) -join " "
  Add-Content -Path "$Work\events.txt" -Value "$What [running: $on]"
}

# Every Jarvis its task started, and any other, holds its log while it runs, as cmd's redirect does.
function global:Update-Log {
  if ($global:jarvis.Count -and -not $global:held) {
    $global:held = [IO.File]::Open("$global:dir\hearth-jarvis.log", "OpenOrCreate", "Write", "Read")
  } elseif (-not $global:jarvis.Count -and $global:held) {
    $global:held.Dispose()
    $global:held = $null
  }
}

# A Jarvis: one since D63 stops when its task run ends; one from before doesn't.
function global:Start-FakeJarvis([int]$Id, [bool]$SinceD63, [bool]$FromTask) {
  $global:jarvis[$Id] = [pscustomobject]@{
    Id = $Id; ProcessName = "node"; StartTime = [datetime]::Now.AddSeconds(-2); SinceD63 = $SinceD63; FromTask = $FromTask
  }
  Set-Content -Path "$global:dir\hearth-jarvis.pid" -Value $Id -NoNewline
  Update-Log
  Write-Event "jarvis $Id starts$(if (-not $SinceD63) { ', from before D63' })"
}

function global:Get-Process { param($Id) $global:jarvis[[int]$Id] }
function global:Get-CimInstance {
  param($ClassName, $Filter)
  if ($Filter -match "^ProcessId = (\d+)$") {
    $j = $global:jarvis[[int]$Matches[1]]
    if ($j) { return [pscustomobject]@{ ProcessId = $j.Id; CreationDate = $j.StartTime } }
    return $null
  }
  if ($Filter -eq "ParentProcessId = 999980" -and $global:taskOn) {
    return @($global:jarvis.Values | Where-Object { $_.FromTask } |
        ForEach-Object { [pscustomobject]@{ Name = "node.exe"; ProcessId = $_.Id; CreationDate = $_.StartTime } })
  }
  throw "Get-CimInstance $ClassName -Filter '$Filter' isn't faked"
}
function global:New-Object {
  if ($global:schedulerDown) { throw "The RPC server is unavailable" }
  $task = [pscustomobject]@{}
  $task | Add-Member -MemberType ScriptMethod -Name GetInstances -Value {
    if ($global:taskOn) { @([pscustomobject]@{ EnginePID = 999980 }) } else { @() }
  }
  $folder = [pscustomobject]@{ Task = $task }
  $folder | Add-Member -MemberType ScriptMethod -Name GetTask -Value { $this.Task }
  $scheduler = [pscustomobject]@{ Folder = $folder }
  $scheduler | Add-Member -MemberType ScriptMethod -Name Connect -Value {}
  $scheduler | Add-Member -MemberType ScriptMethod -Name GetFolder -Value { $this.Folder }
  return $scheduler
}
function global:Get-ScheduledTask {
  param($TaskName)
  return [pscustomobject]@{ TaskName = $TaskName; State = $(if ($global:taskOn) { "Running" } else { "Ready" }) }
}
function global:Stop-ScheduledTask {
  param($TaskName)
  $global:taskOn = $false
  Write-Event "end task"
  foreach ($j in @($global:jarvis.Values | Where-Object { $_.SinceD63 -and $_.FromTask })) {
    $global:jarvis.Remove($j.Id)
    # Its own pid file only: one started after it wrote its own.
    if ("$(Get-Content "$global:dir\hearth-jarvis.pid" -Raw -ErrorAction SilentlyContinue)" -eq "$($j.Id)") {
      Remove-Item "$global:dir\hearth-jarvis.pid"
    }
    Write-Event "jarvis $($j.Id) stops with its task"
  }
  Update-Log
}
function global:Start-ScheduledTask {
  param($TaskName)
  Write-Event "start task"
  $global:taskOn = $true
  if ($global:case -eq "jarvis-throws") { $global:schedulerDown = $true }
  Start-FakeJarvis 999992 $true $true
}
# Your unelevated account can't end the task's Jarvis.
function global:Stop-Process { param($Id, [switch]$Force) Write-Event "kill $Id (access is denied)" }
function global:Start-Service {
  param($Name)
  foreach ($n in @($Name)) {
    # As Windows does: starting one that runs does nothing, so it hasn't restarted.
    if ($global:running[$n]) {
      Write-Event "start $n, already running"
      continue
    }
    if ($global:case -eq "service-fails" -and $n -eq "hearth-worker" -and $global:head -eq $global:new) {
      throw "Service 'hearth-worker' cannot be started"
    }
    $global:running[$n] = $global:head
    $global:started[$n] = [datetime]::UtcNow
    Write-Event "start $n"
  }
}
function global:Stop-Service {
  param($Name)
  foreach ($n in @($Name)) {
    if ($global:case -eq "worker-stop-fails" -and $n -eq "hearth-worker") {
      Write-Event "stop $(@($Name) -join ' '): hearth-worker won't stop"
      throw "Service 'hearth-worker' cannot be stopped"
    }
    $global:running.Remove($n)
  }
  Write-Event "stop $(@($Name) -join ' ')"
}
function global:Get-Service {
  param($Name)
  return [pscustomobject]@{ Name = $Name; Status = $(if ($global:running[$Name]) { "Running" } else { "Stopped" }) }
}
function global:git {
  $global:LASTEXITCODE = 0
  switch ($args[0]) {
    "status" { return }
    "fetch" { return }
    "rev-parse" { if ($args[1] -eq "HEAD") { return $global:head } else { return $global:new } }
    "merge-base" { return }
    "log" { return "2222222 The update" }
    "merge" { $global:head = $global:new; Write-Event "merge"; return }
    "diff" { return }
    "reset" { $global:head = $global:old; Write-Event "reset"; return }
    default { throw "git $args isn't faked" }
  }
}
function global:pnpm {
  $global:LASTEXITCODE = 0
  $what = "$args"
  if ($what -match "hearth doctor") { return '{"checks":[{"name":"Node","mark":"ok","detail":"v22"}]}' }
  Write-Event "pnpm $what"
  if ($what -match "hearth migrate") { return "Up to date." }
  if ($what -match "^install" -and $global:case -eq "leftover" -and $global:head -eq $global:new) {
    Start-FakeJarvis 999996 $false $false
  }
}
function global:pg_dump { $global:LASTEXITCODE = 0 }
# The server's deep health, from what runs: the worker and Jarvis report in only while they run,
# and the new code doesn't fit the database when it shouldn't.
function global:Invoke-RestMethod {
  $sha = $global:running["hearth-server"]
  if (-not $sha) { throw "Unable to connect to the remote server" }
  $now = [datetime]::UtcNow.AddSeconds(5).ToString("o")
  $long = [datetime]::UtcNow.AddHours(-1).ToString("o")
  $worker = $(if ($global:running["hearth-worker"]) { $now } else { $long })
  $jarvis = $(if ($global:jarvis.Count) { $now } else { $long })
  return [pscustomobject]@{
    sha = $sha
    startedAt = $global:started["hearth-server"].ToString("o")
    db = [pscustomobject]@{ ok = $true }
    migrations = [pscustomobject]@{ ok = -not ($sha -eq $global:new -and $global:case -eq "jarvis-throws") }
    problems = @("0999_fake")
    components = [pscustomobject]@{
      worker = [pscustomobject]@{ status = "ok"; detail = "Running"; at = $worker }
      jarvis = [pscustomobject]@{ status = "ok"; detail = "Running"; at = $jarvis }
    }
    jarvisAlive = [pscustomobject]@{ at = $jarvis; since = $jarvis; pid = @($global:jarvis.Keys)[0] }
  }
}
# Faked time: a wait moves the clock instead of waiting. The count guards against a loop that never
# ends.
function global:Start-Sleep {
  param([int]$Milliseconds, [int]$Seconds)
  if (++$global:sleeps -gt 1000) { throw "update.ps1 waited too often: a loop that never ends?" }
  $global:clock = $global:clock.AddMilliseconds($Milliseconds + 1000 * $Seconds)
}
function global:Get-Date {
  param([string]$Format)
  if ($Format) { return $global:clock.ToString($Format) }
  return $global:clock
}
$refusal = { param($name) "throw '$name isn''t faked'" }
foreach ($name in "Invoke-WebRequest", "node", "psql", "taskkill", "schtasks", "Restart-Service", "Set-Service",
  "Register-ScheduledTask", "Unregister-ScheduledTask", "Enable-ScheduledTask", "Disable-ScheduledTask") {
  Set-Item "function:global:$name" -Value ([scriptblock]::Create((& $refusal $name)))
}

# Never the real thing: every command that could reach a real Hearth must be a fake from this file
# by now, or one of the refusals above. Being a function isn't enough: Windows' own
# Stop-ScheduledTask and Start-ScheduledTask are functions too (the ScheduledTasks module's).
foreach ($name in "Get-Process", "Get-CimInstance", "New-Object", "Get-ScheduledTask", "Stop-ScheduledTask",
  "Start-ScheduledTask", "Stop-Process", "Start-Service", "Stop-Service", "Get-Service", "git", "pnpm", "pg_dump",
  "Invoke-RestMethod", "Invoke-WebRequest", "node", "psql", "taskkill", "schtasks", "Restart-Service",
  "Set-Service", "Register-ScheduledTask", "Unregister-ScheduledTask", "Enable-ScheduledTask", "Disable-ScheduledTask") {
  $command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
  $fake = "$($command.CommandType)" -eq "Function" -and
    ($command.ScriptBlock.File -eq $PSCommandPath -or "$($command.ScriptBlock)".Trim() -eq (& $refusal $name))
  if (-not $fake) { throw "$name isn't faked" }
}

$global:running["hearth-server"] = $global:old
$global:running["hearth-worker"] = $global:old
$global:started["hearth-server"] = [datetime]::UtcNow.AddHours(-1)
$global:started["hearth-worker"] = [datetime]::UtcNow.AddHours(-1)
$global:taskOn = $true
Start-FakeJarvis 999988 $true $true
if ($global:case -eq "stuck-first") { Start-FakeJarvis 999984 $false $false }
& "$PSScriptRoot\update.ps1" -Root "$Work\root" -HealthTimeoutSec 0 -Force:$force
$code = $LASTEXITCODE
if ($global:held) { $global:held.Dispose() }
exit $code
