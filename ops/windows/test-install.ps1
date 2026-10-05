<#
  End-to-end test of Hearth's Windows install, on a throwaway Windows machine (CI): install.ps1
  for real, as administrator, then update.ps1 and `hearth restart jarvis` the way you run them,
  from the same account unelevated. CI runs each phase as its own step, in this order:
    powershell -NoProfile -ExecutionPolicy Bypass -File ops\windows\test-install.ps1 -Phase install
  then update, restart, update-new and rollback, and logs when one fails.

  Never on your Hearth PC: it reinstalls Hearth's services and tasks from this checkout, points
  the checkout's origin elsewhere and moves it between commits. It refuses to run outside CI.

  Jarvis needs no Claude login here: it only calls the model for a turn, nothing here talks to
  it, and `hearth pause` keeps its routines from spending turns of their own.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("install", "update", "restart", "update-new", "rollback", "logs")]
  [string]$Phase
)
$ErrorActionPreference = "Stop"
if ($env:GITHUB_ACTIONS -ne "true") { throw "test-install.ps1 reinstalls Hearth's services; it only runs on CI." }
$Root = (Resolve-Path "$PSScriptRoot\..\..").Path
Set-Location $Root
. "$PSScriptRoot\control.ps1"
$work = Join-Path $env:RUNNER_TEMP "hearth-install"
$remote = Join-Path $work "remote.git"
$edit = Join-Path $work "edit"
$branch = "ci-deploy"
$serviceDir = Join-Path $env:ProgramData "Hearth\services"
New-Item -ItemType Directory -Force $work | Out-Null

function Fail([string]$Why) { throw "FAILED: $Why" }

function Get-Head { return (git -C $Root rev-parse HEAD).Trim() }

# The Jarvis processes: node running main.ts jarvis. Should Windows not show even this elevated
# step a command line, a node that isn't one of the two services' counts as well.
function Get-JarvisNodes {
  $all = @(Get-CimInstance Win32_Process)
  $services = @($all | Where-Object { $_.Name -in "hearth-server.exe", "hearth-worker.exe" } | ForEach-Object { $_.ProcessId })
  return @($all | Where-Object {
      $_.Name -eq "node.exe" -and ($_.CommandLine -match 'main\.ts"?\s+jarvis' -or
        (-not $_.CommandLine -and $services -notcontains $_.ParentProcessId))
    })
}

# Hearth is up on $Sha since $Since (UTC): the services and Jarvis's task running, deep health as
# update.ps1 waits for it, and exactly one Jarvis, the one checking in.
function Assert-Up([string]$Sha, [datetime]$Since, [string]$What, [string[]]$Parts = @("server", "worker", "jarvis")) {
  foreach ($name in "hearth-server", "hearth-worker") {
    $status = "$((Get-Service $name).Status)"
    if ($status -ne "Running") { Fail "${What}: $name is $status" }
  }
  $why = Wait-Hearth -Since $Since -Sha $Sha -Parts $Parts -TimeoutSec 180
  if ($why) { Fail "${What}: $why" }
  $state = "$((Get-ScheduledTask -TaskName 'Hearth Jarvis').State)"
  if ($state -ne "Running") { Fail "${What}: the Hearth Jarvis task is $state" }
  $deep = (Get-DeepHealth).Body
  $nodes = Get-JarvisNodes
  if ($nodes.Count -ne 1) {
    $all = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | ForEach-Object { "$($_.ProcessId): $($_.CommandLine)" })
    Fail "${What}: $($nodes.Count) Jarvis processes are running. All node.exe: $($all -join ' | ')"
  }
  if ($nodes[0].ProcessId -ne $deep.jarvisAlive.pid) {
    Fail "${What}: the Jarvis running (pid $($nodes[0].ProcessId)) isn't the one checking in (pid $($deep.jarvisAlive.pid))"
  }
  Write-Host "${What}: both services running, the server on $(Format-Sha $deep.sha) since $($deep.startedAt), one Jarvis (pid $($deep.jarvisAlive.pid), checked in since $($deep.jarvisAlive.since))."
}

# Runs $Command in Windows PowerShell as this account unelevated, the way you run update.ps1: a
# Limited scheduled task, like Jarvis's own. Prints what it printed; returns its exit code.
function Invoke-Unelevated([string]$Name, [string]$Command, [int]$TimeoutSec = 600) {
  $out = Join-Path $work "$Name.out.log"
  $codeFile = Join-Path $work "$Name.code"
  $wrapper = Join-Path $work "$Name.ps1"
  Remove-Item $out, $codeFile -ErrorAction SilentlyContinue
  # A task gets the account's environment, not this job's, whose PATH has node, pnpm and pg_dump.
  $pathFile = Join-Path $work "path.txt"
  Set-Content -Path $wrapper -Encoding UTF8 -Value @(
    "`$env:Path = [IO.File]::ReadAllText('$pathFile').Trim()",
    "`$me = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())",
    "Write-Host ('As ' + [Security.Principal.WindowsIdentity]::GetCurrent().Name + ', administrator: ' + `$me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))",
    "Set-Location '$Root'",
    $Command,
    "`$code = `$LASTEXITCODE",
    "Set-Content -Path '$codeFile' -Value `$code",
    "exit `$code"
  )
  $task = "Hearth CI $Name"
  $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\cmd.exe" -WorkingDirectory $Root `
    -Argument "/d /c powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$wrapper`" > `"$out`" 2>&1"
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds $TimeoutSec) -Priority 4
  Register-ScheduledTask -TaskName $task -Action $action -Principal $principal -Settings $settings -Force | Out-Null
  $started = Get-Date
  Start-ScheduledTask -TaskName $task | Out-Null
  while (-not (Test-Path $codeFile)) {
    $state = "$((Get-ScheduledTask -TaskName $task).State)"
    $elapsed = ((Get-Date) - $started).TotalSeconds
    if (($state -ne "Running" -and $elapsed -gt 20) -or $elapsed -gt $TimeoutSec) { break }
    Start-Sleep -Seconds 3
  }
  Write-Host "---- $Command (as a Limited task)"
  Get-Content -Encoding UTF8 $out -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $_" }
  Write-Host "----"
  if (-not (Test-Path $codeFile)) {
    $result = (Get-ScheduledTask -TaskName $task | Get-ScheduledTaskInfo).LastTaskResult
    Fail ("{0} didn't finish within {1} s (task result 0x{2:X})" -f $Command, $TimeoutSec, $result)
  }
  if (Select-String -Quiet -Path $out -Pattern "administrator: True") {
    Write-Warning "The runner gave the Limited task a full administrator token: this ran elevated."
  }
  return [int](Get-Content $codeFile -Raw).Trim()
}

function Assert-Said([string]$Name, [string]$Pattern) {
  if (-not (Select-String -Quiet -Path (Join-Path $work "$Name.out.log") -Pattern $Pattern)) {
    Fail "$Name didn't say /$Pattern/"
  }
}

# A commit on the deploy branch, made in a clone of it, as a push to GitHub would be.
function Add-Commit([string]$Message, [scriptblock]$Change) {
  if (-not (Test-Path $edit)) { git clone -q --branch $branch $remote $edit | Out-Null }
  git -C $edit pull -q --ff-only | Out-Null
  & $Change | Out-Null
  git -C $edit add -A | Out-Null
  git -C $edit -c user.name=ci -c user.email=ci@localhost commit -q -m $Message | Out-Null
  git -C $edit push -q origin $branch | Out-Null
  if ($LASTEXITCODE) { Fail "couldn't push $Message" }
  return (git -C $edit rev-parse HEAD).Trim()
}

function Invoke-Update([string]$Name, [string]$Arguments = "") {
  return Invoke-Unelevated $Name "& powershell.exe -NoProfile -ExecutionPolicy Bypass -File '$Root\ops\windows\update.ps1' -Branch $branch $Arguments"
}

switch ($Phase) {
  "install" {
    # What a real install has that a CI checkout doesn't. You cloned Hearth's folder, so it's
    # yours; here the runner's elevated account made it and pnpm's store, so let this account
    # write them unelevated, and tell git the checkout is fine to use.
    $mySid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $store = "$(pnpm store path)".Trim()
    foreach ($dir in @($Root, $work, $store)) {
      if ($dir -and (Test-Path $dir)) { icacls $dir /grant "*${mySid}:(OI)(CI)M" /C /Q | Out-Null }
    }
    git config --system --add safe.directory "*"
    Set-Content -Path (Join-Path $work "path.txt") -Encoding UTF8 -Value $env:Path
    # The services run node from the runner's tool cache (on your PC it's in Program Files).
    icacls (Split-Path (Get-Command node).Source) /grant "*S-1-5-19:(OI)(CI)RX" /C /Q | Out-Null
    # .env as docs\setup-windows.md has you write it.
    Set-Content -Path "$Root\.env" -Encoding ASCII -Value @(
      "HEARTH_DATABASE_URL=$env:HEARTH_DATABASE_URL",
      "HEARTH_ORIGIN=http://localhost:4400",
      "HEARTH_HOST=127.0.0.1",
      "HEARTH_PORT=4400",
      "HEARTH_WEB_DIST=apps/web/dist",
      "HEARTH_DATA_DIR=$Root\data",
      "HEARTH_CHROME_LAUNCH=off"
    )
    pnpm -s hearth setup | Out-Null
    if ($LASTEXITCODE) { Fail "hearth setup exited $LASTEXITCODE" }
    pnpm -s hearth pause | Out-Null
    if ($LASTEXITCODE) { Fail "hearth pause exited $LASTEXITCODE" }
    # update.ps1 pulls from origin: here a bare repository on this machine, with this commit as
    # the deploy branch.
    git init -q --bare $remote
    git -C $Root push -q $remote "HEAD:refs/heads/$branch"
    if ($LASTEXITCODE) { Fail "couldn't push to $remote" }
    git -C $Root remote set-url origin $remote

    $since = [datetime]::UtcNow
    $log = Join-Path $work "install.out.log"
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$Root\ops\windows\install.ps1" -SkipChromeTask |
      Tee-Object -FilePath $log | Out-Host
    if ($LASTEXITCODE) { Fail "install.ps1 exited $LASTEXITCODE" }
    if (-not (Select-String -Quiet -Path $log -Pattern "Jarvis is running \(it checked in at")) {
      Fail "install.ps1 didn't see Jarvis check in"
    }
    if (Select-String -Quiet -Path $log -Pattern "WARNING") { Fail "install.ps1 warned (above)" }
    Assert-Up (Get-Head) $since "After install.ps1"

    foreach ($name in "hearth-server", "hearth-worker") {
      $account = (Get-CimInstance Win32_Service -Filter "Name = '$name'").StartName
      if ($account -notmatch '^NT AUTHORITY\\Local ?Service$') { Fail "$name runs as $account" }
    }
    $jarvis = Get-ScheduledTask -TaskName "Hearth Jarvis"
    if ("$($jarvis.Principal.LogonType)" -ne "S4U" -or "$($jarvis.Principal.RunLevel)" -ne "Limited" -or $jarvis.Settings.Priority -ne 4) {
      Fail "the Hearth Jarvis task is $($jarvis.Principal.LogonType), $($jarvis.Principal.RunLevel), priority $($jarvis.Settings.Priority)"
    }
    if ("$((Get-ScheduledTask -TaskName 'Hearth backup').State)" -ne "Ready") { Fail "the Hearth backup task isn't ready" }
    $r = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:4400/api/health"
    if ($r.StatusCode -ne 200) { Fail "/api/health answered $($r.StatusCode)" }

    # The doctor, as you'd run it after installing. Claude is a warning (no login on CI) and
    # Jarvis runs anyway; Node 22 and the unpaired extension are warnings too.
    $report = Get-DoctorReport
    if (-not $report.Checks) { Fail "hearth doctor --json said: $($report.Text)" }
    foreach ($c in $report.Checks) { Write-Host ("{0,-5} {1,-14} {2}" -f $c.mark, $c.name, $c.detail) }
    foreach ($name in "hearth-server", "hearth-worker", "Jarvis task", "Backup task", "Server", "Build", "Database", "Migrations", "worker", "jarvis") {
      $mark = Get-DoctorMark $report $name
      if ($mark -ne "ok") { Fail "the doctor's $name check is $mark" }
    }
    $mark = Get-DoctorMark $report "Claude"
    if ($mark -ne "warn") { Fail "expected no Claude login on CI, but the doctor's Claude check is $mark" }
  }

  "update" {
    # Nothing new: -Force runs every step anyway, on the same commit.
    $head = Get-Head
    $since = [datetime]::UtcNow
    $code = Invoke-Update "update" "-Force"
    if ($code -ne 0) { Fail "update.ps1 exited $code" }
    Assert-Said "update" "== DONE: Hearth is up on $($head.Substring(0, 7))"
    Assert-Up $head $since "After update.ps1 -Force"
  }

  "restart" {
    $since = [datetime]::UtcNow
    $code = Invoke-Unelevated "restart" "& pnpm hearth restart jarvis" 240
    if ($code -ne 0) { Fail "hearth restart jarvis exited $code" }
    Assert-Said "restart" "Hearth's jarvis is back up"
    Assert-Up (Get-Head) $since "After hearth restart jarvis" @("jarvis")
  }

  "update-new" {
    # A change to update.ps1 itself: its new copy takes over right after the merge (-Relaunched).
    $new = Add-Commit "CI: a change to update.ps1" {
      Add-Content -Path "$edit\ops\windows\update.ps1" -Value "# CI: a change, so the update hands over to this copy."
    }
    $since = [datetime]::UtcNow
    $code = Invoke-Update "update-new"
    if ($code -ne 0) { Fail "update.ps1 exited $code" }
    Assert-Said "update-new" "This update changes the updater"
    Assert-Said "update-new" "== Carrying on with the updated update.ps1"
    Assert-Said "update-new" "== DONE: Hearth is up on $($new.Substring(0, 7))"
    if ((Get-Head) -ne $new) { Fail "the checkout is on $(Get-Head), not $new" }
    Assert-Up $new $since "After updating to a new update.ps1"
  }

  "rollback" {
    # A migration that applies, then one that fails: the update reverts the first and goes back.
    $old = Get-Head
    $dir = "$edit\packages\db\migrations"
    $null = Add-Commit "CI: a migration that fails" {
      Set-Content -Path "$dir\0998_ci_applies.up.sql" -Value "CREATE TABLE ci_rollback_probe (id int);"
      Set-Content -Path "$dir\0998_ci_applies.down.sql" -Value "DROP TABLE ci_rollback_probe;"
      Set-Content -Path "$dir\0999_ci_fails.up.sql" -Value "SELECT 1 / 0;"
      Set-Content -Path "$dir\0999_ci_fails.down.sql" -Value "SELECT 1;"
    }
    $since = [datetime]::UtcNow
    $code = Invoke-Update "rollback"
    if ($code -eq 0) { Fail "update.ps1 succeeded with a migration that fails" }
    Assert-Said "rollback" "UPDATE FAILED: Migrating the database failed"
    Assert-Said "rollback" "== Reverting migration 0998_ci_applies"
    Assert-Said "rollback" "== Hearth is back up on $($old.Substring(0, 7))"
    if ((Get-Head) -ne $old) { Fail "the checkout is on $(Get-Head), not back on $old" }
    $probe = "$(psql $env:HEARTH_DATABASE_URL -tAc "SELECT to_regclass('ci_rollback_probe')")".Trim()
    if ($probe) { Fail "the reverted migration's table is still there" }
    Assert-Up $old $since "After the rollback"
  }

  "logs" {
    Write-Host "== Tasks"
    Get-ScheduledTask -TaskName "Hearth*" -ErrorAction SilentlyContinue | ForEach-Object {
      $i = $_ | Get-ScheduledTaskInfo
      Write-Host ("{0}: {1}, last run {2}, result 0x{3:X}" -f $_.TaskName, $_.State, $i.LastRunTime, $i.LastTaskResult)
    }
    Write-Host "== Services"
    Get-Service hearth-* -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "$($_.Name): $($_.Status)" }
    Write-Host "== Jarvis processes"
    Get-JarvisNodes | ForEach-Object { Write-Host "$($_.ProcessId) (parent $($_.ParentProcessId)), started $($_.CreationDate)" }
    Write-Host "== Deep health"
    $deep = Get-DeepHealth
    if ($deep.Body) { $deep.Body | ConvertTo-Json -Depth 5 | Write-Host } else { Write-Host "HTTP $($deep.Status)" }
    $logs = @(Get-ChildItem $serviceDir -Filter *.log -ErrorAction SilentlyContinue) +
      @(Get-ChildItem "$Root\data\logs" -Filter update-*.log -ErrorAction SilentlyContinue) +
      @(Get-ChildItem $work -Filter *.out.log -ErrorAction SilentlyContinue)
    foreach ($f in $logs) {
      Write-Host "== $($f.FullName)"
      Get-Content -Tail 80 $f.FullName | ForEach-Object { Write-Host "  $_" }
    }
  }
}
