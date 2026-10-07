<#
  Hearth's Windows CI runner on this PC (D66, docs\ci.md): GitHub's runner in D:\hearth-ci\runner-win,
  registered as hearth-pc-win, running as you, unelevated, at below-normal priority, one job at a
  time. This starts and stops it; it never registers or reconfigures it.

    powershell -File ops\ci-runner\windows-runner.ps1 -Install   run it off your desktop, from every restart (administrator)
    powershell -File ops\ci-runner\windows-runner.ps1 -Uninstall stop doing that (administrator)
    powershell -File ops\ci-runner\windows-runner.ps1 -Start     start it now, and the test cluster on 5499
    powershell -File ops\ci-runner\windows-runner.ps1 -Stop      stop it (and the job it's running)
    powershell -File ops\ci-runner\windows-runner.ps1 -Status    is it running, where, and how

  Off your desktop: -Install registers the task "Hearth CI runner", which runs as you whether or not
  you're signed in, without storing your password, in the session services use. Nothing a job
  starts can open a window there. On your desktop it could: when a running job is cancelled,
  GitHub's runner lets go of its hidden console to stop the step, and every process it starts
  after that (the job's clean-up steps) opens a console window of its own.

  -Install also copies this script to D:\hearth-ci (the checkout it runs from may move or be
  cleaned), which the task runs with -Run. Jobs inherit the runner's priority, so the tests,
  servers and Chromium it starts all yield to the live Hearth.
#>
param(
  [switch]$Install,
  [switch]$Uninstall,
  [switch]$Start,
  [switch]$Stop,
  [switch]$Status,
  # What the task runs: the test cluster, then the runner in the foreground until it stops.
  [switch]$Run
)
$ErrorActionPreference = "Stop"

$Root = "D:\hearth-ci"
$Runner = Join-Path $Root "runner-win"
$Installed = Join-Path $Root "windows-runner.ps1"
$TaskName = "Hearth CI runner"
# Before the task, a shortcut in the Startup folder started the runner on the desktop.
$Shortcut = Join-Path ([Environment]::GetFolderPath("Startup")) "Hearth CI runner.lnk"

# The runner: Runner.Listener, and Runner.Worker while it runs a job.
function Get-RunnerProcess {
  Get-CimInstance Win32_Process -Filter "Name = 'Runner.Listener.exe' OR Name = 'Runner.Worker.exe'" |
    Where-Object { $_.ExecutablePath -like "$Runner\*" }
}

# The Postgres test cluster on 5499 that CI's jobs (and local tests) use. Nothing else starts it
# after Windows restarts, and every job fails at its first step without it.
$PgBin = "C:\Program Files\PostgreSQL\17\bin"
$TestDb = Join-Path $env:LOCALAPPDATA "HearthTestDb"
function Test-TestDb {
  & "$PgBin\pg_isready.exe" -q -h 127.0.0.1 -p 5499
  $LASTEXITCODE -eq 0
}
# pg_ctl runs in its own hidden window, never piped: postgres keeps any output handle it inherits
# open, so reading pg_ctl's output would wait as long as the cluster runs and the runner never start.
function Start-TestDb {
  if (Test-TestDb) { Write-Host "The test cluster on 5499 is up."; return }
  if (-not (Test-Path (Join-Path $TestDb "PG_VERSION"))) { Write-Host "No test cluster in $TestDb (docs\ci.md)."; return }
  $ctl = Start-Process -FilePath "$PgBin\pg_ctl.exe" -WindowStyle Hidden -PassThru `
    -ArgumentList "start -D `"$TestDb`" -l `"$(Join-Path $TestDb 'server.log')`" -w -t 60"
  if (-not $ctl.WaitForExit(90000)) { Write-Host "pg_ctl is still waiting; the runner starts anyway." }
  if (Test-TestDb) { Write-Host "Started the test cluster on 5499." } else { Write-Host "The test cluster didn't start; see $TestDb\server.log." }
}

# Everything run from D:\hearth-ci: the runner, and a job's Node, pnpm and Chromium. Never the live
# Hearth's programs, which run from elsewhere (and as another account, which this can't even see).
function Get-CiProcess {
  Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like "$Root\*" }
}

function Get-RunnerTask { Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }

function Test-Administrator {
  $me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Killing, never cancelling: a killed runner runs no clean-up steps, so it opens no windows either.
function Stop-Runner {
  $runner = @(Get-RunnerProcess)
  if ($runner | Where-Object { $_.Name -eq "Runner.Worker.exe" }) {
    Write-Host "It was running a job, which ends unfinished; run it again from GitHub."
  }
  # The cmd.exe of run.cmd, then the runner, then whatever its job left: all from D:\hearth-ci.
  $parents = @($runner | ForEach-Object { $_.ParentProcessId } | Sort-Object -Unique)
  foreach ($id in $parents) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId = $id"
    if ($p -and $p.Name -eq "cmd.exe" -and $p.CommandLine -like "*$Runner*") {
      Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
    }
  }
  foreach ($p in @($runner) + @(Get-CiProcess)) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Wait-Runner {
  $deadline = (Get-Date).AddSeconds(30)
  while (-not (Get-RunnerProcess) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  [bool](Get-RunnerProcess)
}

if (-not ($Install -or $Uninstall -or $Start -or $Stop -or $Status -or $Run)) {
  Write-Host "Say what to do: -Install, -Uninstall, -Start, -Stop or -Status."
  exit 2
}
if (-not (Test-Path (Join-Path $Runner "run.cmd"))) {
  throw "No runner in $Runner. It's set up once by hand (docs\ci.md, Adding a runner)."
}

if ($Run) {
  try { Start-TestDb } catch { Write-Host "Couldn't start the test cluster: $_" }
  if (Get-RunnerProcess) { Write-Host "The runner is already running."; exit 0 }
  # start /belownormal sets the priority as the runner starts, so everything it runs inherits it
  # (the task itself runs at normal priority: Task Scheduler's own below-normal also lowers disk
  # priority, which would slow every job). /wait holds the task open as long as the runner runs.
  $p = Start-Process -FilePath (Join-Path $env:SystemRoot "System32\cmd.exe") -WorkingDirectory $Runner -NoNewWindow -PassThru `
    -ArgumentList "/c start `"hearth-ci`" /belownormal /b /wait cmd.exe /c `"$Runner\run.cmd`""
  $p.WaitForExit()
  exit $p.ExitCode
}

if ($Install) {
  if (-not (Test-Administrator)) {
    throw "Registering a task that runs whether or not you're signed in needs an administrator PowerShell. Nothing changed."
  }
  if ($PSCommandPath -ne $Installed) { Copy-Item -LiteralPath $PSCommandPath -Destination $Installed -Force }
  $me = [Security.Principal.WindowsIdentity]::GetCurrent()
  $powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $action = New-ScheduledTaskAction -Execute $powershell -WorkingDirectory $Root `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$Installed`" -Run"
  # S4U: as you, signed in or not, with no password stored; Limited: never elevated.
  $principal = New-ScheduledTaskPrincipal -UserId $me.Name -LogonType S4U -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -Priority 5 `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -Settings $settings -Force `
    -Trigger (New-ScheduledTaskTrigger -AtStartup) `
    -Description "Hearth's CI runner (D:\hearth-ci\runner-win), off the desktop, at below-normal priority" | Out-Null
  # You (and the sessions working for you, unelevated) can start it and see it; only an
  # administrator can change it.
  try {
    $service = New-Object -ComObject Schedule.Service
    $service.Connect()
    $service.GetFolder("\").GetTask($TaskName).SetSecurityDescriptor("D:P(A;;FA;;;BA)(A;;FA;;;SY)(A;;GRGX;;;$($me.User.Value))", 0)
  } catch { Write-Host "Couldn't let you start it unelevated ($_); -Start then needs an administrator." }
  if (Get-RunnerProcess) { Write-Host "Stopping the runner on your desktop."; Stop-Runner }
  Start-ScheduledTask -TaskName $TaskName
  if (Wait-Runner) {
    if (Test-Path -LiteralPath $Shortcut) { Remove-Item -LiteralPath $Shortcut }
    Write-Host "The runner runs off your desktop as $($me.Name), and starts with Windows."
  } else {
    # Back as it was: no task, the shortcut kept. Not started from here, which would run it elevated.
    $result = (Get-ScheduledTaskInfo -TaskName $TaskName).LastTaskResult
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    throw "The task didn't start the runner (result $result; see $Runner\_diag). Nothing stays changed: start it again from a normal PowerShell with -Start."
  }
}

if ($Uninstall) {
  if (-not (Test-Administrator)) { throw "Removing the task needs an administrator PowerShell. Nothing changed." }
  if (Get-RunnerTask) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
  if (Test-Path -LiteralPath $Shortcut) { Remove-Item -LiteralPath $Shortcut }
  Write-Host "The runner no longer starts with Windows. (It keeps running until -Stop.)"
}

if ($Stop) {
  if (Get-RunnerTask) { try { Stop-ScheduledTask -TaskName $TaskName } catch { } }
  Stop-Runner
  Write-Host "Stopped. GitHub shows hearth-pc-win offline until -Start."
}

if ($Start) {
  if (Get-RunnerProcess) {
    Write-Host "The runner is already running."
  } elseif (Get-RunnerTask) {
    Start-ScheduledTask -TaskName $TaskName
    if (Wait-Runner) { Write-Host "Started the runner, off your desktop." } else { throw "The runner didn't start; see $Runner\_diag." }
  } else {
    # Not installed: on the desktop, hidden. A cancelled job can still open windows here (-Install).
    try { Start-TestDb } catch { Write-Host "Couldn't start the test cluster: $_" }
    Start-Process -FilePath (Join-Path $env:SystemRoot "System32\cmd.exe") -WorkingDirectory $Runner `
      -ArgumentList "/c start `"hearth-ci`" /belownormal /b cmd.exe /c `"$Runner\run.cmd`"" -WindowStyle Hidden
    if (Wait-Runner) { Write-Host "Started the runner on your desktop." } else { throw "The runner didn't start; see $Runner\_diag." }
  }
}

if ($Status) {
  $runner = @(Get-RunnerProcess)
  if (-not $runner) {
    Write-Host "The runner isn't running. Start it with -Start."
  } else {
    foreach ($p in $runner) {
      $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
      $where = if ($p.SessionId -eq 0) { "off your desktop" } else { "on your desktop (session $($p.SessionId))" }
      Write-Host ("{0} (pid {1}), {2} priority, {3}, since {4}" -f $p.Name, $p.ProcessId, $proc.PriorityClass, $where, $p.CreationDate)
    }
    $busy = $runner | Where-Object { $_.Name -eq "Runner.Worker.exe" }
    if ($busy) { Write-Host "Running a job now." } else { Write-Host "Waiting for a job." }
  }
  if (Test-TestDb) { Write-Host "The test cluster on 5499 is up." } else { Write-Host "The test cluster on 5499 isn't answering; -Start starts it." }
  $task = Get-RunnerTask
  if ($task) { Write-Host "Starts with Windows, off your desktop (the task '$TaskName', $($task.State))." }
  elseif (Test-Path -LiteralPath $Shortcut) { Write-Host "Starts at sign-in on your desktop ($Shortcut); -Install moves it off." }
  else { Write-Host "Doesn't start by itself (-Install)." }
}
