<#
  control.ps1's tests for Jarvis (control-jarvis.ps1): finding, stopping and waiting for it, and
  starting and stopping Hearth around it. Part of test-control.ps1, which dot-sources this file
  after its own tests (it defines Assert-Equal, and fakes Start-Sleep and Get-DeepHealth): run that.
  Touches nothing: the processes, the task, the services, the request and the log are all faked.
#>

# Stop-Jarvis trusts its pid file only for the process that wrote it: the file outlives a Jarvis
# that was killed or crashed, and Windows hands its pid to later processes. One whose start time
# Windows won't tell this account (the task's Jarvis, from your unelevated account: 2026-10-05)
# may be Jarvis: unverified, so it's neither ended nor taken for stopped.
$written = [datetime]::new(2026, 10, 4, 12, 0, 0)
$node = { param($started, $id = 999999) [pscustomobject]@{ ProcessName = "node"; Id = $id; StartTime = $started } }
$sessionZero = { param($id) $p = [pscustomobject]@{ ProcessName = "node"; Id = $id }; $p | Add-Member -MemberType ScriptProperty -Name StartTime -Value { throw "Access is denied" }; $p }
Assert-Equal (Resolve-JarvisPid (& $node $written.AddSeconds(-20)) $written) "jarvis" "the Jarvis that wrote the pid file"
Assert-Equal (Resolve-JarvisPid (& $node $written.AddHours(2)) $written) "" "a later node.exe that got the same pid"
Assert-Equal (Resolve-JarvisPid (& $node $null) $written) "unverified" "a node.exe whose start time comes back blank"
Assert-Equal (Resolve-JarvisPid (& $sessionZero 999999) $written) "unverified" "a node.exe that won't say when it started"
Assert-Equal (Resolve-JarvisPid ([pscustomobject]@{ ProcessName = "chrome"; StartTime = $written.AddSeconds(-20) }) $written) "" "not node"
Assert-Equal (Resolve-JarvisPid $null $written) "" "no process with that pid"

# Whether Jarvis has stopped, from what's still running and whether its log is free.
$log = "C:\nowhere\hearth-jarvis.log"
$sure = [pscustomobject]@{ Id = 999999; Verified = $true }
$maybe = [pscustomobject]@{ Id = 999996; Verified = $false }
$stuck = { param($ids) Format-StuckJarvis $ids }
Assert-Equal (Get-JarvisVerdict @() $true $log) "" "nothing running, the log free: stopped"
Assert-Equal (Get-JarvisVerdict @($sure) $true $log) (& $stuck @(999999)) "Jarvis still running, sure: named"
Assert-Equal (Get-JarvisVerdict @($maybe) $false $log) (& $stuck @(999996)) "maybe Jarvis, and the log held: named"
Assert-Equal (Get-JarvisVerdict @($maybe) $true $log) "" "maybe Jarvis, but the log free: some other node.exe got its pid"
Assert-Equal (Get-JarvisVerdict @() $false $log) `
  "Something still holds Jarvis's log (C:\nowhere\hearth-jarvis.log) open, most likely an older Jarvis that Hearth can't stop or name from your account: end it as administrator (Task Manager, Details: the node.exe in session 0 running as you), then try again right away" `
  "the log held by nothing it can name"
Assert-Equal (Format-StuckJarvis @(8, 12)) `
  "An older Jarvis (pids 8, 12) is still running and Hearth can't stop it from your account: run taskkill /F /PID 8 /PID 12 as administrator, then try again right away" "two at once"

# Stop-Jarvis itself, with the pid file, the processes, the task, the request and the log faked:
# nothing real is asked, ended or read. 9999xx can't be real pids (Windows' are multiples of 4).
function Get-ServiceDir { "C:\nowhere\services" }
function Test-Path { param($Path) $script:pidFileThere }
function Get-Content { param($Path, [switch]$Raw) "$script:pidInFile`r`n" }
function Get-Item { param($Path) [pscustomobject]@{ LastWriteTime = $written } }
function Get-Process { param($Id) $script:running[[int]$Id] }
function Stop-Process { param($Id, [switch]$Force) $script:did += "kill $Id"; if ($script:killable) { $script:running.Remove([int]$Id) } }
function Stop-ScheduledTask { $script:did += "end task" }
# Jarvis since D63 stops when asked: it's gone, and its log with it.
function Request-JarvisStop { $script:did += "ask"; if ($script:honours) { $script:running.Clear() } }
# Every Jarvis its task started holds the log.
function Test-LogFree { -not @($script:holders | Where-Object { $script:running.ContainsKey($_) }).Count }
function Get-CimInstance { @($script:children | ForEach-Object { [pscustomobject]@{ Name = "node.exe"; ProcessId = $_ } }) }
function New-Object {
  $task = [pscustomobject]@{ Runs = $script:runs }
  $task | Add-Member -MemberType ScriptMethod -Name GetInstances -Value { $this.Runs }
  $folder = [pscustomobject]@{ Task = $task }
  $folder | Add-Member -MemberType ScriptMethod -Name GetTask -Value { $this.Task }
  $scheduler = [pscustomobject]@{ Folder = $folder }
  $scheduler | Add-Member -MemberType ScriptMethod -Name Connect -Value {}
  $scheduler | Add-Member -MemberType ScriptMethod -Name GetFolder -Value { $this.Folder }
  return $scheduler
}
# A situation: what's running (pid => process), which of them hold the log, and how they behave.
function Set-Jarvis([hashtable]$Running, [int[]]$Holders = @(), [switch]$Honours, [switch]$Killable, [int]$InFile = 999999, [int[]]$Children = @()) {
  $script:running = $Running
  $script:holders = $Holders
  $script:honours = [bool]$Honours
  $script:killable = [bool]$Killable
  $script:pidFileThere = $InFile -ne 0
  $script:pidInFile = $InFile
  $script:children = $Children
  $script:runs = @($Children | Select-Object -First 1 | ForEach-Object { [pscustomobject]@{ EnginePID = 999980 } })
  $script:did = @()
  $script:states = @("")
}

Set-Jarvis @{ 999999 = (& $node $written.AddSeconds(-20)) } -Holders 999999 -Honours
Assert-Equal (Stop-Jarvis) "" "a Jarvis since D63 stops when asked"
Assert-Equal ($script:did -join ", ") "ask, end task" "asked, its task ended, nothing killed"

# The 2026-10-05 case: a Jarvis from before D63 ignores the request, and from your account its
# start time can't be read nor can it be ended. It must be named, not taken for stopped.
Set-Jarvis @{ 999996 = (& $sessionZero 999996) } -Holders 999996 -InFile 999996
Assert-Equal (Stop-Jarvis) (& $stuck @(999996)) "an older Jarvis that won't go, unverified, is named"
Assert-Equal ($script:did -join ", ") "ask, end task" "and never killed unverified"

Set-Jarvis @{ 999999 = (& $node $written.AddSeconds(-20)) } -Holders 999999 -Killable
Assert-Equal (Stop-Jarvis) "" "elevated, an older Jarvis is ended once it hasn't stopped when asked"
Assert-Equal ($script:did -join ", ") "ask, end task, kill 999999" "asked first, ended after"

Set-Jarvis @{ 999999 = (& $node $written.AddSeconds(-20)) } -Holders 999999
Assert-Equal (Stop-Jarvis) (& $stuck @(999999)) "a Jarvis it's sure of that won't end is named"

Set-Jarvis @{ 999996 = (& $sessionZero 999996) } -InFile 999996
Assert-Equal (Stop-Jarvis) "" "Jarvis's old pid now another account's node.exe, the log free: stopped"
Assert-Equal ($script:did -join ", ") "ask, end task" "and that node.exe left alone"

Set-Jarvis @{ 999999 = (& $node $written.AddHours(2)) }
Assert-Equal (Stop-Jarvis) "" "a later node.exe with Jarvis's old pid isn't Jarvis"
Assert-Equal ($script:did -join ", ") "ask, end task" "and is left alone"

Set-Jarvis @{ 999992 = (& $sessionZero 999992) } -Holders 999992 -InFile 0
Assert-Equal (Stop-Jarvis) (Get-JarvisVerdict @() $false "C:\nowhere\services\hearth-jarvis.log") "a log held by a Jarvis it can't name"

Set-Jarvis @{ 999988 = (& $node $written.AddSeconds(-20) 999988) } -Holders 999988 -InFile 0 -Children 999988 -Killable
Assert-Equal (Stop-Jarvis) "" "the task's own node child, found before the task is ended"
Assert-Equal ($script:did -join ", ") "ask, end task, kill 999988" "and ended when elevated"

# A Jarvis that won't stop leaves the services alone, unless it's a rollback (-Anyway).
function Stop-Service { param($Name) $script:did += "stop $($Name -join ' ')" }
Set-Jarvis @{ 999996 = (& $sessionZero 999996) } -Holders 999996 -InFile 999996
$threw = ""
try { Stop-Hearth | Out-Null } catch { $threw = "$_" }
Assert-Equal $threw "$(& $stuck @(999996))." "Stop-Hearth stops at a Jarvis that won't go"
Assert-Equal (@($script:did | Where-Object { $_ -like "stop *" }).Count) 0 "and leaves the services running"
Set-Jarvis @{ 999996 = (& $sessionZero 999996) } -Holders 999996 -InFile 999996
Stop-Hearth -Anyway | Out-Null
Assert-Equal ($script:did[-1]) "stop hearth-server hearth-worker" "a rollback stops the services anyway"
# And starts all but that Jarvis again: its task couldn't start another.
$parts = Get-RollbackParts
Assert-Equal "$($parts.Parts) | $($parts.Stuck)" "server worker | $(& $stuck @(999996))" "a rollback leaves a stuck Jarvis out"
Set-Jarvis @{}
Assert-Equal "$((Get-RollbackParts).Parts)" "server worker jarvis" "a rollback starts all of Hearth"

# Waiting for a new Jarvis to check in: its pid file, or the server's word.
function Get-Item { param($Path) [pscustomobject]@{ LastWriteTimeUtc = $script:pidWritten } }
$script:pidWritten = $since.AddMinutes(-5)
$script:answers = @([pscustomobject]@{ Status = 200; Body = (New-Deep) })
Assert-Equal (Wait-JarvisCheckIn $since "x.pid" 0).ToString("o") "2026-10-04T12:00:15.0000000Z" "Jarvis checked in, says the server"
$script:answers = @([pscustomobject]@{ Status = 0; Body = $null })
$script:pidWritten = $since.AddSeconds(30)
Assert-Equal (Wait-JarvisCheckIn $since "x.pid" 0).ToString("o") "2026-10-04T12:00:30.0000000Z" "Jarvis wrote its pid file, with the server down"
$script:pidWritten = $since.AddMinutes(-5)
Assert-Equal (Wait-JarvisCheckIn $since "x.pid" 0) "" "only an old pid file: not checked in"
$script:answers = @([pscustomobject]@{ Status = 200; Body = $survivor })
Assert-Equal (Wait-JarvisCheckIn $since "x.pid" 0) "" "only an old Jarvis checking in: not the new one"

foreach ($f in "Test-Path", "Get-Content", "Get-Item", "Get-Process", "Stop-Process", "Stop-ScheduledTask", "Get-CimInstance",
  "New-Object", "Stop-Service") {
  Remove-Item "function:$f"
}
