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

if ($failures) { Write-Host "$failures failed"; exit 1 }
Write-Host "All passed."
exit 0
