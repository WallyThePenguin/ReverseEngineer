<#
  Hearth's Windows CI runner on this PC (D66, docs\ci.md): GitHub's runner in D:\hearth-ci\runner-win,
  registered as hearth-pc-win, running as you, unelevated, at below-normal priority, one job at a
  time. This starts and stops it; it never registers or reconfigures it. No administrator needed.

    powershell -File ops\ci-runner\windows-runner.ps1 -Install   start it at every sign-in
    powershell -File ops\ci-runner\windows-runner.ps1 -Uninstall stop starting it at sign-in
    powershell -File ops\ci-runner\windows-runner.ps1 -Start     start it now, hidden
    powershell -File ops\ci-runner\windows-runner.ps1 -Stop      stop it (and the job it's running)
    powershell -File ops\ci-runner\windows-runner.ps1 -Status    is it running, and how

  -Install copies this script to D:\hearth-ci (the checkout it runs from may move or be cleaned)
  and puts a shortcut to its -Start in your Startup folder. Jobs inherit the runner's priority,
  so the tests, servers and Chromium it starts all yield to the live Hearth.
#>
param(
  [switch]$Install,
  [switch]$Uninstall,
  [switch]$Start,
  [switch]$Stop,
  [switch]$Status
)
$ErrorActionPreference = "Stop"

$Root = "D:\hearth-ci"
$Runner = Join-Path $Root "runner-win"
$Installed = Join-Path $Root "windows-runner.ps1"
$Shortcut = Join-Path ([Environment]::GetFolderPath("Startup")) "Hearth CI runner.lnk"

# The runner: Runner.Listener, and Runner.Worker while it runs a job.
function Get-RunnerProcess {
  Get-CimInstance Win32_Process -Filter "Name = 'Runner.Listener.exe' OR Name = 'Runner.Worker.exe'" |
    Where-Object { $_.ExecutablePath -like "$Runner\*" }
}

# Everything run from D:\hearth-ci: the runner, and a job's Node, pnpm and Chromium. Never the live
# Hearth's programs, which run from elsewhere (and as another account, which this can't even see).
function Get-CiProcess {
  Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like "$Root\*" }
}

if (-not ($Install -or $Uninstall -or $Start -or $Stop -or $Status)) {
  Write-Host "Say what to do: -Install, -Uninstall, -Start, -Stop or -Status."
  exit 2
}
if (-not (Test-Path (Join-Path $Runner "run.cmd"))) {
  throw "No runner in $Runner. It's set up once by hand (docs\ci.md, Adding a runner)."
}

if ($Install) {
  if ($PSCommandPath -ne $Installed) { Copy-Item -LiteralPath $PSCommandPath -Destination $Installed -Force }
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut($Shortcut)
  $link.TargetPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $link.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Installed`" -Start"
  $link.WorkingDirectory = $Root
  $link.WindowStyle = 7
  $link.Description = "Starts Hearth's CI runner (D:\hearth-ci\runner-win) at below-normal priority"
  $link.Save()
  Write-Host "At every sign-in, $Shortcut starts the runner. Start it now with -Start."
}

if ($Uninstall) {
  if (Test-Path -LiteralPath $Shortcut) { Remove-Item -LiteralPath $Shortcut }
  Write-Host "The runner no longer starts at sign-in. (It keeps running until -Stop.)"
}

if ($Stop) {
  $runner = @(Get-RunnerProcess)
  if ($runner | Where-Object { $_.Name -eq "Runner.Worker.exe" }) {
    Write-Host "It's running a job, which ends unfinished; run it again from GitHub."
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
  Write-Host "Stopped. GitHub shows hearth-pc-win offline until -Start."
}

if ($Start) {
  if (Get-RunnerProcess) {
    Write-Host "The runner is already running."
  } else {
    # start /belownormal sets the priority as the runner starts, so everything it runs inherits it;
    # /b keeps it in this hidden window, and cmd /c lets that window close when the runner ends.
    Start-Process -FilePath (Join-Path $env:SystemRoot "System32\cmd.exe") -WorkingDirectory $Runner `
      -ArgumentList "/c start `"hearth-ci`" /belownormal /b cmd.exe /c `"$Runner\run.cmd`"" -WindowStyle Hidden
    $deadline = (Get-Date).AddSeconds(20)
    while (-not (Get-RunnerProcess) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
    if (Get-RunnerProcess) { Write-Host "Started the runner." } else { throw "The runner didn't start; see $Runner\_diag." }
  }
}

if ($Status) {
  $runner = @(Get-RunnerProcess)
  if (-not $runner) {
    Write-Host "The runner isn't running. Start it with -Start."
  } else {
    foreach ($p in $runner) {
      $priority = (Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue).PriorityClass
      Write-Host ("{0} (pid {1}), {2} priority, since {3}" -f $p.Name, $p.ProcessId, $priority, $p.CreationDate)
    }
    $busy = $runner | Where-Object { $_.Name -eq "Runner.Worker.exe" }
    if ($busy) { Write-Host "Running a job now." } else { Write-Host "Waiting for a job." }
  }
  if (Test-Path -LiteralPath $Shortcut) { Write-Host "Starts at sign-in ($Shortcut)." } else { Write-Host "Doesn't start at sign-in (-Install)." }
}
