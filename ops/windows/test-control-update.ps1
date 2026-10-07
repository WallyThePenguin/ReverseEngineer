<#
  update.ps1 rolling back, run for real with everything it would touch faked (test-update-fakes.ps1,
  in a Windows PowerShell of its own, in a temporary folder). Part of test-control.ps1, which
  dot-sources this file after its own tests (it defines Assert-Equal): run that.

  The rule these check: a rollback never runs git reset, pnpm install or the build while a service
  runs the new code, and starts again only what is down and can start.
#>
$fakeWork = Join-Path ([IO.Path]::GetTempPath()) "hearth-test-update-$PID"

# Runs update.ps1 for -Case (see test-update-fakes.ps1): its exit code, what it printed, and what
# happened, one line each, with the services running then ("reset [running: ]").
function Invoke-FakeUpdate([string]$Case) {
  Remove-Item -Recurse -Force $fakeWork -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force "$fakeWork\root", "$fakeWork\ProgramData\Hearth\services" | Out-Null
  Set-Content -Path "$fakeWork\fake-update" -Value $Case
  # Should anything get past the fakes: no server answers on port 1, nor a database.
  Set-Content -Path "$fakeWork\root\.env" -Value "HEARTH_PORT=1", "HEARTH_DATABASE_URL=postgres://nobody@127.0.0.1:1/none"
  $out = & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass `
    -File "$PSScriptRoot\test-update-fakes.ps1" -Work $fakeWork -Case $Case | Out-String
  $code = $LASTEXITCODE
  $events = @(Get-Content "$fakeWork\events.txt" -ErrorAction SilentlyContinue)
  Remove-Item -Recurse -Force $fakeWork -ErrorAction SilentlyContinue
  return [pscustomobject]@{ Code = $code; Out = $out; Events = $events }
}

# The events from the first that is -like $Like on, as "what [running: ...]" lines, joined for
# comparing.
function Format-From($Run, [string]$Like) {
  $from = [array]::IndexOf($Run.Events, @($Run.Events | Where-Object { $_ -like $Like })[0])
  if ($from -lt 0) { return "nothing like '$Like': $($Run.Out)" }
  return ($Run.Events[$from..($Run.Events.Count - 1)] -join "`n")
}
function Format-AfterMerge($Run) { return Format-From $Run "merge *" }

# A Jarvis from before D63 started while the update installed, holding its log: Start-Hearth must
# refuse before it starts anything, the rollback stops everything, and starts all but that Jarvis.
$run = Invoke-FakeUpdate "leftover"
Assert-Equal $run.Code 1 "an update with a left-over Jarvis fails"
Assert-Equal (Format-AfterMerge $run) (@(
    "merge [running: ]",
    "pnpm install --frozen-lockfile [running: ]",
    "jarvis 999996 starts, from before D63 [running: ]",
    "pnpm build:web [running: ]",
    "pnpm --silent hearth migrate [running: ]",
    "end task [running: ]",
    "kill 999996 (access is denied) [running: ]",
    "stop hearth-server hearth-worker [running: ]",
    "reset [running: ]",
    "pnpm install --frozen-lockfile [running: ]",
    "pnpm build:web [running: ]",
    "start hearth-server [running: hearth-server@1]",
    "start hearth-worker [running: hearth-server@1 hearth-worker@1]"
  ) -join "`n") "nothing starts on the new code, the old code goes back with nothing running, and that Jarvis is left out"
Assert-Equal ($run.Out -match "Hearth is back up on 1111111, with Jarvis left as it was\. An older Jarvis \(pid 999996\)") $true `
  "and it says which Jarvis to end"

# hearth-worker won't start on the new code after hearth-server has (the verifier's blocker): the
# rollback must stop hearth-server before it puts the old code back under it.
$run = Invoke-FakeUpdate "service-fails"
Assert-Equal $run.Code 1 "an update whose worker won't start fails"
Assert-Equal (Format-AfterMerge $run) (@(
    "merge [running: ]",
    "pnpm install --frozen-lockfile [running: ]",
    "pnpm build:web [running: ]",
    "pnpm --silent hearth migrate [running: ]",
    "start hearth-server [running: hearth-server@2]",
    "end task [running: hearth-server@2]",
    "stop hearth-server hearth-worker [running: ]",
    "reset [running: ]",
    "pnpm install --frozen-lockfile [running: ]",
    "pnpm build:web [running: ]",
    "start hearth-server [running: hearth-server@1]",
    "start hearth-worker [running: hearth-server@1 hearth-worker@1]",
    "start task [running: hearth-server@1 hearth-worker@1]",
    "jarvis 999992 starts [running: hearth-server@1 hearth-worker@1]"
  ) -join "`n") "the server on the new code is stopped before the old code goes back"
Assert-Equal ($run.Out -match "== Hearth is back up on 1111111\.") $true "and all of Hearth is back on the old code"

# The new code isn't healthy, and stopping Jarvis then fails outright: the rollback stops the
# services anyway, and starts them again without Jarvis, which it can't tell about.
$run = Invoke-FakeUpdate "jarvis-throws"
Assert-Equal $run.Code 1 "an update that isn't healthy fails"
Assert-Equal (Format-AfterMerge $run) (@(
    "merge [running: ]",
    "pnpm install --frozen-lockfile [running: ]",
    "pnpm build:web [running: ]",
    "pnpm --silent hearth migrate [running: ]",
    "start hearth-server [running: hearth-server@2]",
    "start hearth-worker [running: hearth-server@2 hearth-worker@2]",
    "start task [running: hearth-server@2 hearth-worker@2]",
    "jarvis 999992 starts [running: hearth-server@2 hearth-worker@2]",
    "stop hearth-server hearth-worker [running: ]",
    "reset [running: ]",
    "pnpm install --frozen-lockfile [running: ]",
    "pnpm build:web [running: ]",
    "start hearth-server [running: hearth-server@1]",
    "start hearth-worker [running: hearth-server@1 hearth-worker@1]"
  ) -join "`n") "Stop-Jarvis throwing in a rollback still stops the services first"
Assert-Equal ($run.Out -match "Stopping Jarvis failed: The RPC server is unavailable") $true "and it says stopping Jarvis failed"

# A Jarvis from before D63 won't stop, so the update's stop fails before the services: Hearth was
# never down, so nothing starts, nothing is waited for, and it doesn't say Hearth isn't back up.
$run = Invoke-FakeUpdate "stuck-first"
Assert-Equal $run.Code 1 "an update that can't stop Jarvis fails"
Assert-Equal @($run.Events | Where-Object { $_ -match "^(start|stop) hearth-|^merge" }).Count 0 `
  "and never stops, starts or moves anything"
Assert-Equal ($run.Out -match "An older Jarvis \(pid 999984\)") $true "and it says which Jarvis to end"
Assert-Equal ($run.Out -match "Hearth's services were never stopped: it's still up on 1111111") $true `
  "and that Hearth is still up"
Assert-Equal ($run.Out -match "ISN'T BACK UP") $false "rather than that it isn't back up"

# hearth-worker won't stop after hearth-server has: the server and Jarvis start again, and the
# worker, which never stopped, isn't waited for.
$run = Invoke-FakeUpdate "worker-stop-fails"
Assert-Equal $run.Code 1 "an update whose worker won't stop fails"
Assert-Equal (Format-From $run "stop *") (@(
    "stop hearth-server hearth-worker: hearth-worker won't stop [running: hearth-worker@1]",
    "start hearth-server [running: hearth-server@1 hearth-worker@1]",
    "start task [running: hearth-server@1 hearth-worker@1]",
    "jarvis 999992 starts [running: hearth-server@1 hearth-worker@1]"
  ) -join "`n") "only what stopped starts again, on the same code"
Assert-Equal ($run.Out -match "== Hearth is back up on 1111111\.") $true "and Hearth is back up"

# -Force on the commit Hearth is already on: nothing to roll back, but a start that fails must
# still start Hearth again, or the update leaves it down without a word.
$run = Invoke-FakeUpdate "force-leftover"
Assert-Equal $run.Code 1 "-Force with a left-over Jarvis fails"
Assert-Equal (Format-AfterMerge $run) (@(
    "merge [running: ]",
    "pnpm install --frozen-lockfile [running: ]",
    "jarvis 999996 starts, from before D63 [running: ]",
    "pnpm build:web [running: ]",
    "pnpm --silent hearth migrate [running: ]",
    "start hearth-server [running: hearth-server@1]",
    "start hearth-worker [running: hearth-server@1 hearth-worker@1]"
  ) -join "`n") "and starts all but that Jarvis again, with nothing reset"
Assert-Equal ($run.Out -match "Hearth is back up on 1111111, with Jarvis left as it was\. An older Jarvis \(pid 999996\)") $true `
  "and says which Jarvis to end"

$run = Invoke-FakeUpdate "force-service-fails"
Assert-Equal $run.Code 1 "-Force with a worker that won't start fails"
Assert-Equal (Format-AfterMerge $run) (@(
    "merge [running: ]",
    "pnpm install --frozen-lockfile [running: ]",
    "pnpm build:web [running: ]",
    "pnpm --silent hearth migrate [running: ]",
    "start hearth-server [running: hearth-server@1]"
  ) -join "`n") "and tries to start what's down again (not the server it started), with nothing reset"
Assert-Equal ($run.Out -match "Couldn't start Hearth again: Service 'hearth-worker' cannot be started") $true "and says it couldn't"
Assert-Equal ($run.Out -match "HEARTH ISN'T BACK UP on 1111111: the worker hasn't reported in since it started") $true `
  "and that Hearth isn't back up"
