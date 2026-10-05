<#
  Tests for the update gate's logic in control.ps1, and that every script in ops\windows parses.
  Touches nothing: no services, no tasks, no network. CI runs it on Windows, on the PC that is also
  the live Hearth's (D66), so test-fence.ps1 checks the fakes before anything is stopped:
    powershell -NoProfile -ExecutionPolicy Bypass -File ops\windows\test-control.ps1
#>
$ErrorActionPreference = "Stop"
$Root = "C:\nowhere"
. "$PSScriptRoot\control.ps1"
. "$PSScriptRoot\test-fence.ps1"
# Hearth's services folder, where a stop request ends the live Jarvis, is found through this.
$env:ProgramData = Join-Path ([IO.Path]::GetTempPath()) "hearth-test-control\ProgramData"
$failures = 0

function Assert-Equal($Actual, $Expected, [string]$What) {
  if ("$Actual" -ne "$Expected") {
    Write-Host "FAIL  $What`n      expected: $Expected`n      actual:   $Actual"
    $script:failures++
  } else {
    Write-Host "ok    $What"
  }
}

# Every script parses.
foreach ($file in Get-ChildItem "$PSScriptRoot\*.ps1") {
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$null, [ref]$errors) | Out-Null
  Assert-Equal $errors.Count 0 "$($file.Name) parses $($errors | ForEach-Object { $_.Message })"
}

# The desktop app's Update and `hearth restart` run these with -File, and Windows PowerShell leaves
# $PSScriptRoot empty in a parameter's default then: Hearth's folder would be C:\.
foreach ($name in "update.ps1", "restart.ps1") {
  $ast = [System.Management.Automation.Language.Parser]::ParseFile("$PSScriptRoot\$name", [ref]$null, [ref]$null)
  $reads = @($ast.ParamBlock.Parameters | Where-Object { "$($_.DefaultValue)" -match "PSScriptRoot" })
  Assert-Equal $reads.Count 0 "$name doesn't read `$PSScriptRoot in a parameter's default"
}

Assert-Equal (Resolve-HearthParts "all") "server worker jarvis" "all means the three parts"
Assert-Equal (Resolve-HearthParts "jarvis") "jarvis" "one part is itself"

# Dates as Windows PowerShell's ConvertFrom-Json leaves them (strings) and as PowerShell 7 makes them.
$t = ConvertTo-UtcTime "2026-10-04T12:00:05.000Z"
Assert-Equal $t.ToString("o") "2026-10-04T12:00:05.0000000Z" "reads an ISO time as UTC"
Assert-Equal (ConvertTo-UtcTime $null) ([datetime]::MinValue) "no time is long ago"

$since = [datetime]::Parse("2026-10-04T12:00:00Z", $null, [Globalization.DateTimeStyles]::AdjustToUniversal)
$sha = "0123456789abcdef0123456789abcdef01234567"
function New-Deep([hashtable]$Change = @{}) {
  $d = @{
    sha = $sha
    startedAt = "2026-10-04T12:00:10.000Z"
    db = [pscustomobject]@{ ok = $true }
    migrations = [pscustomobject]@{ ok = $true }
    problems = @()
    components = [pscustomobject]@{
      worker = [pscustomobject]@{ status = "ok"; detail = "Running"; at = "2026-10-04T12:00:20.000Z" }
      jarvis = [pscustomobject]@{ status = "ok"; detail = "Running"; at = "2026-10-04T12:00:30.000Z" }
    }
    jarvisAlive = [pscustomobject]@{ at = "2026-10-04T12:00:29.000Z"; since = "2026-10-04T12:00:15.000Z"; pid = 4242 }
  }
  foreach ($k in $Change.Keys) { $d[$k] = $Change[$k] }
  return [pscustomobject]$d
}
$all = @("server", "worker", "jarvis")
Assert-Equal (Get-DeepProblem (New-Deep) $since $sha $all) "" "healthy on the new commit"
Assert-Equal (Get-DeepProblem (New-Deep @{ sha = "fedcba9876543210" }) $since $sha $all) `
  "the server runs fedcba9, not 0123456" "the old commit still running"
Assert-Equal (Get-DeepProblem (New-Deep @{ migrations = [pscustomobject]@{ ok = $false }; problems = @("missing 0022") }) $since $sha $all) `
  "the database doesn't fit the code (missing 0022)" "migrations not applied"
Assert-Equal (Get-DeepProblem (New-Deep @{ startedAt = "2026-10-04T11:00:00.000Z" }) $since "" $all) `
  "the server hasn't restarted" "a server that wasn't restarted"
$quiet = New-Deep
$quiet.components.jarvis.at = "2026-10-04T11:59:00.000Z"
Assert-Equal (Get-DeepProblem $quiet $since $sha $all) "the jarvis hasn't reported in since it started" "Jarvis not back yet"
Assert-Equal (Get-DeepProblem $quiet $since $sha @("server", "worker")) "" "Jarvis not restarted, not waited for"
$down = New-Deep
$down.components.worker.status = "failing"
$down.components.worker.detail = "Won't start: the database is missing 1 update(s)"
Assert-Equal (Get-DeepProblem $down $since $sha $all) "the worker says: Won't start: the database is missing 1 update(s)" "a worker that refuses to start"

# Jarvis's health says how its last turn went, which a restart doesn't change: failing before
# the update, it only has to report in, or the update that fixes its turns would be rolled back.
$turns = New-Deep
$turns.components.jarvis.status = "failing"
$turns.components.jarvis.detail = "A turn failed at 9:14: Claude rejected a tool."
Assert-Equal (Get-DeepProblem $turns $since $sha $all) "the jarvis says: A turn failed at 9:14: Claude rejected a tool." "Jarvis failing, and it wasn't before"
Assert-Equal (Get-DeepProblem $turns $since $sha $all @("jarvis")) "" "Jarvis failing before too: reporting in is enough"
$turns.components.jarvis.at = "2026-10-04T11:59:00.000Z"
Assert-Equal (Get-DeepProblem $turns $since $sha $all @("jarvis")) "the jarvis hasn't reported in since it started" "Jarvis failing before still has to report in"

# The worker reports Jarvis failing once it hasn't checked in for 5 minutes. With Jarvis down
# before the restart (so in $Failed), that report isn't the new Jarvis checking in.
$surrogate = New-Deep
$surrogate.components.jarvis.status = "failing"
$surrogate.components.jarvis.detail = "Jarvis hasn't checked in since 11:54. Its service may have stopped."
$surrogate.jarvisAlive.at = "2026-10-04T11:54:00.000Z"
$surrogate.jarvisAlive.since = "2026-10-04T09:00:00.000Z"
Assert-Equal (Get-DeepProblem $surrogate $since $sha $all @("jarvis")) "Jarvis hasn't checked in since it started" "the worker's word that Jarvis is down isn't Jarvis checking in"
Assert-Equal (Get-DeepProblem $surrogate $since $sha @("jarvis") @("jarvis")) "Jarvis hasn't checked in since it started" "the same for hearth restart jarvis"
# A Jarvis the stop missed keeps checking in, on the old code: it started before the restart.
# Checking in since, it's still running, and the gate says which pid to end (2026-10-05).
$survivor = New-Deep
$survivor.jarvisAlive.since = "2026-10-04T09:00:00.000Z"
Assert-Equal (Get-DeepProblem $survivor $since $sha $all) `
  "An older Jarvis (pid 4242) is still running and Hearth can't stop it from your account: run taskkill /F /PID 4242 as administrator, then try again right away" `
  "an old Jarvis still checking in isn't the new one, and is named"
$survivor.jarvisAlive.at = "2026-10-04T11:59:30.000Z"
Assert-Equal (Get-DeepProblem $survivor $since $sha $all) "Jarvis hasn't checked in since it started" "one not heard from since the restart may be gone: not named"
$surrogate.jarvisAlive = $null
Assert-Equal (Get-DeepProblem $surrogate $since $sha $all @("jarvis")) "Jarvis hasn't checked in since it started" "a Jarvis that never checked in"
$older = New-Deep
$older.PSObject.Properties.Remove("jarvisAlive")
Assert-Equal (Get-DeepProblem $older $since $sha $all) "" "a server from before jarvisAlive (a rollback): its components are enough"
Assert-Equal (Get-FailingParts $turns) "jarvis" "what deep health said was failing before a restart"
Assert-Equal (Get-FailingParts $null) "" "nothing known before a restart"
$doctorBefore = [pscustomobject]@{ Checks = @([pscustomobject]@{ name = "jarvis"; mark = "fail"; detail = "x" }, [pscustomobject]@{ name = "worker"; mark = "ok"; detail = "Running" }); Text = $null }
Assert-Equal (Get-FailingChecks $doctorBefore) "jarvis" "what the doctor said was failing before an update"
Assert-Equal (Get-FailingChecks ([pscustomobject]@{ Checks = $null; Text = "$([char]0x2717) jarvis         stale`r`n" })) "jarvis" "the same from the text doctor"

# Wait-Hearth, with the server faked.
$script:answers = @()
function Get-DeepHealth {
  $next = $script:answers[0]
  if ($script:answers.Count -gt 1) { $script:answers = $script:answers[1..($script:answers.Count - 1)] }
  return $next
}
$script:answers = @([pscustomobject]@{ Status = 200; Body = (New-Deep) })
Assert-Equal (Wait-Hearth -Since $since -Sha $sha -TimeoutSec 0) "" "Wait-Hearth: healthy at once"
$script:answers = @([pscustomobject]@{ Status = 404; Body = $null })
Assert-Equal (Wait-Hearth -Since $since -Sha $sha -TimeoutSec 0) "the server is still the old one (no /api/health/deep)" "Wait-Hearth: no deep health on the new code"
Assert-Equal (Wait-Hearth -Since $since -Sha $sha -TimeoutSec 0 -AllowOld) "" "Wait-Hearth: back on code from before deep health"
$script:answers = @([pscustomobject]@{ Status = 0; Body = $null })
Assert-Equal (Wait-Hearth -Since $since -TimeoutSec 0) "the server isn't answering" "Wait-Hearth: nothing answering"

# The doctor before and after an update.
$ok = [char]0x2713
$cross = [char]0x2717
$text = [pscustomobject]@{
  Checks = $null
  Text = "$ok Node           v24.1.0`r`n! Login          No passkey yet.`r`n$cross worker         stopped`r`n$ok Database       Connected`r`n"
}
Assert-Equal (Get-DoctorMark $text "Node") "ok" "reads ok from the text doctor"
Assert-Equal (Get-DoctorMark $text "Login") "warn" "reads warn from the text doctor"
Assert-Equal (Get-DoctorMark $text "worker") "fail" "reads fail from the text doctor"
Assert-Equal (Get-DoctorMark $text "Disk C:") "" "a check the text doctor didn't have"

$fail = { param($n, $d = "broken") [pscustomobject]@{ name = $n; mark = "fail"; detail = $d } }
$okc = { param($n) [pscustomobject]@{ name = $n; mark = "ok"; detail = "fine" } }
$before = [pscustomobject]@{ Checks = @((& $fail "Disk C:"), (& $okc "Database"), (& $okc "mail")); Text = $null }
$after = [pscustomobject]@{ Checks = @((& $fail "Disk C:"), (& $okc "Database"), (& $fail "mail"), (& $fail "Tailscale")); Text = $null }
$diff = Compare-Doctor $before $after
Assert-Equal ($diff.New | ForEach-Object { $_.name }) "mail" "a check that broke in the update"
Assert-Equal ($diff.Old | ForEach-Object { $_.name }) "Disk C:" "a check that failed before too"
Assert-Equal ($diff.Unknown | ForEach-Object { $_.name }) "Tailscale" "a check the old doctor didn't have"
$fromText = Compare-Doctor $text ([pscustomobject]@{ Checks = @((& $fail "worker"), (& $fail "Database"), (& $fail "Disk C:")) })
Assert-Equal ($fromText.New | ForEach-Object { $_.name }) "Database" "compared with the text doctor: new"
Assert-Equal ($fromText.Old | ForEach-Object { $_.name }) "worker" "compared with the text doctor: old"

# Two checks under one name (as the backup task and the backup component once were): a failure
# from before stays old. Names match exactly: the Server check isn't the server component.
$twice = [pscustomobject]@{ Checks = @((& $okc "backup"), (& $fail "backup" "Upload failed"), (& $fail "server"), (& $okc "Server")); Text = $null }
$same = Compare-Doctor $twice ([pscustomobject]@{ Checks = @((& $okc "backup"), (& $fail "backup" "Upload failed"), (& $fail "Server")); Text = $null })
Assert-Equal ($same.Old | ForEach-Object { $_.name }) "backup" "a name used twice: the failure from before stays old"
Assert-Equal ($same.New | ForEach-Object { $_.name }) "Server" "names match exactly, not ignoring case"

# What a rollback reverts: what `hearth migrate` printed as applied, even when it then failed.
Assert-Equal (Get-AppliedMigrations "Applied: 0025_a, 0026_b`r`n") "0025_a 0026_b" "reads the migrations an update applied"
Assert-Equal (Get-AppliedMigrations "Up to date.`r`n").Count 0 "nothing applied"
# Reverting them, with pnpm faked: newest first, each by name, stopping at one that won't revert.
$script:ran = @()
$script:stuck = ""
function pnpm {
  $script:ran += "$args"
  $global:LASTEXITCODE = 0
  if ($script:stuck -and $args[-1] -eq $script:stuck) { $global:LASTEXITCODE = 1 }
}
Assert-Equal (Undo-Migrations @("0023_late", "0025_a")) $true "reverts every migration the update applied"
Assert-Equal ($script:ran -join "; ") "--silent hearth migrate down 0025_a; --silent hearth migrate down 0023_late" "newest first, each by name"
$script:ran = @()
$script:stuck = "0025_a"
Assert-Equal (Undo-Migrations @("0023_late", "0025_a", "0026_b")) $false "a migration that won't revert"
Assert-Equal ($script:ran -join "; ") "--silent hearth migrate down 0026_b; --silent hearth migrate down 0025_a" "stops at the one that won't revert"
Assert-Equal (Undo-Migrations @()) $true "nothing applied, nothing to revert"
Remove-Item function:pnpm

# An update that changes update.ps1 hands over to the new copy right after the merge.
$bound = [ordered]@{ Root = "C:\old"; Branch = "main"; Force = [switch]$true; HealthTimeoutSec = 60; Verbose = [switch]$false }
Assert-Equal ((Get-RelaunchArgs $bound "D:\My Hearth\ops\windows\update.ps1" "D:\My Hearth") -join "|") `
  "-NoProfile|-File|D:\My Hearth\ops\windows\update.ps1|-Root|D:\My Hearth|-Branch|main|-Force|-HealthTimeoutSec|60|-Relaunched" `
  "the new copy gets this run's parameters, -Root and -Relaunched"
Assert-Equal ((Get-RelaunchArgs @{} "D:\H\ops\windows\update.ps1" "D:\H") -join "|") `
  "-NoProfile|-File|D:\H\ops\windows\update.ps1|-Root|D:\H|-Relaunched" "a run given no parameters"
# The new copy faked: it reads where the update left off and deletes the file, as update.ps1 does.
$handoverFile = Join-Path ([IO.Path]::GetTempPath()) "hearth-test-handover-$PID.xml"
$state = [pscustomobject]@{ Old = "0ld"; New = "n3w"; Before = $doctorBefore }
function Invoke-NewCopy {
  $s = Import-Clixml $handoverFile
  Remove-Item $handoverFile
  $script:carried = "$($s.Old) $($s.New) $(Get-FailingChecks $s.Before)"
  $global:LASTEXITCODE = 3
}
$code = 1
Invoke-Handover "Invoke-NewCopy" @() $state $handoverFile ([ref]$code)
Assert-Equal $script:carried "0ld n3w jarvis" "the new copy reads where the update left off, the doctor's report included"
Assert-Equal $code 3 "this run exits with the new copy's exit code"
# A new copy that never takes over (it doesn't parse, say): this run must roll back itself.
function Invoke-NewCopy { $global:LASTEXITCODE = 1 }
$code = 1
$threw = ""
try { Invoke-Handover "Invoke-NewCopy" @() $state $handoverFile ([ref]$code) } catch { $threw = "$_" }
Assert-Equal $threw "The updated update.ps1 didn't start (exit 1)" "a new copy that never took over"
Assert-Equal (Test-Path $handoverFile) $false "leaves no handover behind"
Remove-Item function:Invoke-NewCopy

# Waiting for Jarvis's task to stop before it's started again, with Windows faked.
$script:states = @()
function Get-ScheduledTask {
  param([string]$TaskName)
  $next = $script:states[0]
  if ($script:states.Count -gt 1) { $script:states = $script:states[1..($script:states.Count - 1)] }
  if (-not $next) { return $null }
  return [pscustomobject]@{ TaskName = $TaskName; State = $next }
}
function Start-Sleep { param([int]$Milliseconds, [int]$Seconds) }
$script:states = @("Running", "Running", "Ready")
Assert-Equal (Wait-TaskStopped "Hearth Jarvis" 5) $true "waits for the task to stop"
Assert-Equal $script:states.Count 1 "asked until it stopped"
$script:states = @("")
Assert-Equal (Wait-TaskStopped "Hearth Jarvis" 5) $true "no task: nothing to wait for"
$script:states = @("Running")
Assert-Equal (Wait-TaskStopped "Hearth Jarvis" 0) $false "gives up when it won't stop"

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
function Stop-Service { param($Name) $script:did += "stop $($Name -join ' ')" }
function Start-Service { param($Name) $script:did += "start $($Name -join ' ')" }
function Start-ScheduledTask { $script:did += "start task" }
# Nothing below reaches the real thing: every command these can reach is one of the fakes above.
Assert-Fenced -Entry "Stop-Jarvis", "Stop-Hearth", "Start-Hearth", "Get-RollbackParts" -Fakes $PSCommandPath `
  -Code "$PSScriptRoot\control.ps1" -Faked "Stop-Service", "Start-Service", "Stop-ScheduledTask",
  "Start-ScheduledTask", "Stop-Process", "Request-JarvisStop", "Get-ServiceDir", "New-Object", "Get-CimInstance"

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

foreach ($f in "Test-Path", "Get-Content", "Get-Item", "Get-Process", "Stop-Process", "Stop-ScheduledTask", "Get-CimInstance", "New-Object", "Stop-Service", "Start-Service", "Start-ScheduledTask") {
  Remove-Item "function:$f"
}

if ($failures) { Write-Host "$failures failed"; exit 1 }
Write-Host "All passed."
exit 0
