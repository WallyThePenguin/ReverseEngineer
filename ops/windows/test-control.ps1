<#
  Tests for the update gate's logic in control.ps1, and that every script in ops\windows parses.
  Touches nothing: no services, no tasks, no network. CI runs it on Windows:
    powershell -NoProfile -ExecutionPolicy Bypass -File ops\windows\test-control.ps1
#>
$ErrorActionPreference = "Stop"
$Root = "C:\nowhere"
. "$PSScriptRoot\control.ps1"
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

# The desktop app's Update and `hearth restart` run these with -File (CI runs install.ps1 so), and
# Windows PowerShell leaves $PSScriptRoot empty in a parameter's default then: Hearth's folder
# would be C:\.
foreach ($name in "update.ps1", "restart.ps1", "install.ps1") {
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
# Time faked from here: a wait moves this clock instead of waiting, and Get-Date reads it.
$script:clock = [datetime]::new(2026, 10, 4, 12, 0, 0)
function Get-Date { $script:clock }
function Start-Sleep { param([int]$Milliseconds, [int]$Seconds) $script:clock = $script:clock.AddMilliseconds($Milliseconds + 1000 * $Seconds) }
$script:states = @("Running", "Running", "Ready")
Assert-Equal (Wait-TaskStopped "Hearth Jarvis" 5) $true "waits for the task to stop"
Assert-Equal $script:states.Count 1 "asked until it stopped"
$script:states = @("")
Assert-Equal (Wait-TaskStopped "Hearth Jarvis" 5) $true "no task: nothing to wait for"
$script:states = @("Running")
Assert-Equal (Wait-TaskStopped "Hearth Jarvis" 0) $false "gives up when it won't stop"

# Finding, stopping and waiting for Jarvis (control-jarvis.ps1), with Windows faked.
. "$PSScriptRoot\test-control-jarvis.ps1"
# update.ps1 itself rolling back, run with everything it would touch faked.
. "$PSScriptRoot\test-control-update.ps1"

if ($failures) { Write-Host "$failures failed"; exit 1 }
Write-Host "All passed."
exit 0
