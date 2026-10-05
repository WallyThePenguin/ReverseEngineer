<#
.SYNOPSIS
  Installs Hearth's two Windows services (server, worker), Jarvis and the nightly backup task.

.DESCRIPTION
  Run from an elevated PowerShell in the Hearth folder, after `pnpm install`, `pnpm build:web`
  and `pnpm hearth setup`. See docs/setup-windows.md.

  - hearth-server and hearth-worker run as LocalService (no password, few rights).
  - Jarvis runs as your account, so it can use your Claude login: the "Hearth Jarvis" task starts
    it when Windows starts and when you sign in. Like the backup task, it needs no stored password
    (that's why it isn't a service: a service as you would need your password).
  - The backup runs nightly at 2:30 a.m. as you, whether or not you're signed in.
  - The "Hearth Chrome" task opens your Chrome, as you, on your desktop: when you sign in, and
    when Jarvis needs it and it's closed (the server asks Windows to run it). Run this script from
    your own Windows account (Run as administrator), so the task is yours and finds your Chrome.
#>
[CmdletBinding()]
param(
  # Hearth's folder; by default the one this script is in.
  [string]$Root,
  [string]$BackupTime = "02:30",
  [switch]$SkipBackupTask,
  # Chrome's profile folder with the Hearth extension, like "Default" or "Profile 1". Chrome shows
  # it on chrome://version as the last part of "Profile Path". Defaults to the profile the Hearth
  # extension is loaded in, or the last one you used.
  [string]$ChromeProfile = "",
  [switch]$SkipChromeTask
)
$ErrorActionPreference = "Stop"
# Not as the parameter's default: Windows PowerShell leaves $PSScriptRoot empty there for a script
# run with -File (powershell -File install.ps1), and Hearth's folder would be the drive's root.
if (-not $Root) { $Root = (Resolve-Path "$PSScriptRoot\..\..").Path }
# Finding, stopping and waiting for Jarvis and the server, as update.ps1 does.
. "$PSScriptRoot\control.ps1"

$WinSWVersion = "v2.12.0"
$WinSWSha256 = "05B82D46AD331CC16BDC00DE5C6332C1EF818DF8CEEFCD49C726553209B3A0DA"
$ServiceDir = Join-Path $env:ProgramData "Hearth\services"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this from an elevated PowerShell (Run as administrator)."
}
if (-not $SkipChromeTask) {
  # The task that opens Chrome runs as whoever runs this script, so that has to be you.
  $console = (Get-CimInstance Win32_ComputerSystem).UserName
  if ($console -and $console -ne "$env:USERDOMAIN\$env:USERNAME") {
    throw "Windows is signed in as $console, but this PowerShell runs as $env:USERDOMAIN\$env:USERNAME. Run it as administrator from $console's own account (or add -SkipChromeTask)."
  }
}
$node = (Get-Command node -ErrorAction Stop).Source
if (-not (Test-Path "$Root\apps\cli\src\main.ts")) { throw "$Root doesn't look like the Hearth folder." }
if (-not (Test-Path "$Root\apps\web\dist\index.html")) { throw "Build the web app first: pnpm build:web" }

New-Item -ItemType Directory -Force -Path $ServiceDir | Out-Null
$winsw = Join-Path $ServiceDir "WinSW-$WinSWVersion.exe"
if (-not (Test-Path $winsw)) {
  Write-Host "Downloading WinSW $WinSWVersion..."
  Invoke-WebRequest -UseBasicParsing -OutFile $winsw `
    -Uri "https://github.com/winsw/winsw/releases/download/$WinSWVersion/WinSW-x64.exe"
}
$hash = (Get-FileHash -Algorithm SHA256 $winsw).Hash
if ($hash -ne $WinSWSha256) {
  Remove-Item $winsw
  throw "WinSW download didn't match its expected checksum. Nothing was installed."
}

$me = "$env:USERDOMAIN\$env:USERNAME"
$mySid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value

# Lets your own (unelevated) account start, stop and query one of Hearth's services, so updates
# (ops/windows/update.ps1) don't need an administrator. Nothing else about the service changes.
function Grant-ServiceControl([string]$Id, [string]$Sid) {
  $sddl = ((& sc.exe sdshow $Id) -join "").Trim()
  if (-not $sddl.Contains("D:")) { throw "Couldn't read $Id's permissions: $sddl" }
  if ($sddl -match "\(A;;[A-Z]*RP[A-Z]*;;;$Sid\)") { return }
  $ace = "(A;;CCLCSWRPWPLORC;;;$Sid)"
  $at = $sddl.IndexOf("S:")
  $new = if ($at -ge 0) { $sddl.Insert($at, $ace) } else { $sddl + $ace }
  & sc.exe sdset $Id $new | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Couldn't let you start and stop $Id (sc sdset exit $LASTEXITCODE)." }
}

# LocalService needs to read the app and write its own logs; Jarvis (you) writes its log there too.
# No /T: the folder's (OI)(CI) grant is inherited by everything in it, which Windows applies in
# seconds, where /T rewrote each of node_modules' ~20,000 files one by one (minutes). node_modules
# holds copies, not links into pnpm's store (.npmrc), so its files inherit like the rest.
Write-Host "Letting Hearth's services read $Root..."
icacls $Root /grant "*S-1-5-19:(OI)(CI)RX" /C /Q | Out-Null
icacls $ServiceDir /grant "*S-1-5-19:(OI)(CI)M" "${me}:(OI)(CI)M" /C /Q | Out-Null
$probe = Get-ChildItem -LiteralPath "$Root\node_modules\.pnpm" -Recurse -File -Filter package.json -ErrorAction SilentlyContinue |
  Select-Object -First 1
if ($probe -and (fsutil hardlink list $probe.FullName 2>$null | Measure-Object).Count -gt 1) {
  Write-Warning "node_modules links into pnpm's store, so the services can't read it. Run: Remove-Item -Recurse -Force node_modules; pnpm install"
}

foreach ($svc in "server", "worker") {
  $id = "hearth-$svc"
  $exe = Join-Path $ServiceDir "$id.exe"
  $xml = Join-Path $ServiceDir "$id.xml"
  if (Get-Service $id -ErrorAction SilentlyContinue) {
    Write-Host "Stopping and removing the old $id..."
    & $exe stopwait | Out-Null
    & $exe uninstall | Out-Null
  }
  Copy-Item $winsw $exe -Force
  (Get-Content "$PSScriptRoot\$id.xml" -Raw).Replace("{{NODE}}", $node).Replace("{{ROOT}}", $Root) |
    Set-Content -Encoding UTF8 $xml
  & $exe install
  if ($LASTEXITCODE -ne 0) { throw "Installing $id failed (exit $LASTEXITCODE)." }
  # A failed grant only means updates need an administrator; never let it stop the install.
  try { Grant-ServiceControl $id $mySid } catch { Write-Warning "$_ Updates will need an administrator." }
  & $exe start
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "$id is installed but didn't start. Windows Event Viewer (Windows Logs > System) says why."
  } else {
    Write-Host "Started $id."
  }
}

# Jarvis used to be a service as you, which meant typing your Windows password. Remove that one.
$oldJarvis = Join-Path $ServiceDir "hearth-jarvis.exe"
if ((Test-Path $oldJarvis) -and (Get-Service hearth-jarvis -ErrorAction SilentlyContinue)) {
  Write-Host "Removing the old hearth-jarvis service..."
  & $oldJarvis stopwait | Out-Null
  & $oldJarvis uninstall | Out-Null
}
# Only that service's files: hearth-jarvis.log, .pid and .stop are the task's.
foreach ($ext in "exe", "xml", "out.log", "err.log", "wrapper.log") {
  Remove-Item (Join-Path $ServiceDir "hearth-jarvis.$ext") -ErrorAction SilentlyContinue
}

# Jarvis: as you (S4U: no password, no window), restarted if it stops.
# HEARTH_AS_SERVICE tells it to open Chrome through the "Hearth Chrome" task, on your desktop,
# and to stop when asked or when its task is stopped (D63: apps/jarvis/src/stop-request.ts).
$jarvisLog = Join-Path $ServiceDir "hearth-jarvis.log"
$jarvisPidFile = Join-Path $ServiceDir "hearth-jarvis.pid"
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\cmd.exe" -WorkingDirectory $Root `
  -Argument "/d /c set HEARTH_AS_SERVICE=1&& `"$node`" --env-file-if-exists=`"$Root\.env`" `"$Root\apps\cli\src\main.ts`" jarvis >> `"$jarvisLog`" 2>&1"
# At boot, so Jarvis is back after Windows restarts on its own (an update overnight) without
# waiting for you to sign in: S4U runs it without you. Two minutes in, once Postgres is up. And
# when you sign in, in case it stopped; IgnoreNew keeps it to one Jarvis.
$atBoot = New-ScheduledTaskTrigger -AtStartup
$atBoot.Delay = "PT2M"
$atSignIn = New-ScheduledTaskTrigger -AtLogOn -User $me
$atSignIn.Delay = "PT30S"
# Priority 4, like "Hearth Chrome" below: normal CPU, disk and memory priority. Without it the
# task runs at 7, below normal, and on a busy PC Jarvis took two minutes to start.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -Priority 4
$user = New-ScheduledTaskPrincipal -UserId $me -LogonType S4U -RunLevel Limited
if (Get-ScheduledTask -TaskName "Hearth Jarvis" -ErrorAction SilentlyContinue) {
  # Asked first, as updates ask (D63): a Jarvis since then stops the way SIGTERM stops it.
  Request-JarvisStop $ServiceDir
  Stop-ScheduledTask -TaskName "Hearth Jarvis"
}
# Stopping the task ends cmd; a Jarvis from before D63 runs on. Never leave two Jarvises running,
# nor one holding its log, which the new one's cmd couldn't then open. Elevated, every node's
# command line can be read, and any that's left is ended.
$strays = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -match 'main\.ts"?\s+jarvis' } |
  ForEach-Object { [pscustomobject]@{ Id = [int]$_.ProcessId; Verified = $true; Started = $_.CreationDate } })
$left = Wait-JarvisGone $strays $jarvisLog 15
if ($left) {
  foreach ($j in $strays) { Stop-Process -Id $j.Id -Force -ErrorAction SilentlyContinue }
  $left = Wait-JarvisGone $strays $jarvisLog 15
}
if ($left) { Write-Warning "Couldn't stop the Jarvis already running: $left." }
# Its log carries on from install to install; one over 10 MB is kept as hearth-jarvis.old.log.
if ((Test-Path $jarvisLog) -and (Get-Item $jarvisLog).Length -gt 10MB) {
  Move-Item -Force $jarvisLog (Join-Path $ServiceDir "hearth-jarvis.old.log") -ErrorAction SilentlyContinue
}
Register-ScheduledTask -TaskName "Hearth Jarvis" -TaskPath "\" -Action $action -Trigger $atBoot, $atSignIn `
  -Settings $settings -Principal $user -Force `
  -Description "Runs Jarvis, Hearth's agent, as you so it can use your Claude login." | Out-Null
# Your unelevated account may start and stop this task (for updates), and so may LocalService (the
# worker, which restarts Jarvis when it stops checking in). Like "Hearth Chrome" below: read and
# run this one task, nothing more.
try {
  $scheduler = New-Object -ComObject Schedule.Service
  $scheduler.Connect()
  $jarvisTask = $scheduler.GetFolder("\").GetTask("Hearth Jarvis")
  $sddl = $jarvisTask.GetSecurityDescriptor(7)
  foreach ($who in $mySid, "LS") {
    if ($sddl -notmatch "\(A;[^;]*;[^;]*GX[^;]*;;;$who\)") { $sddl += "(A;;GRGX;;;$who)" }
  }
  $jarvisTask.SetSecurityDescriptor($sddl, 0)
} catch {
  Write-Warning "Couldn't let you and the worker run the Hearth Jarvis task ($_). Updates will need an administrator."
}
# While Windows still counts the stopped run, IgnoreNew would drop this start without a word.
if (-not (Wait-TaskStopped "Hearth Jarvis")) { Write-Warning "The Hearth Jarvis task hasn't stopped yet." }
$jarvisSince = [datetime]::UtcNow
Start-ScheduledTask -TaskName "Hearth Jarvis"
Write-Host "Started the Hearth Jarvis task; waiting for Jarvis to check in..."
$checkedIn = Wait-JarvisCheckIn $jarvisSince $jarvisPidFile
if ($checkedIn) {
  Write-Host "Jarvis is running (it checked in at $($checkedIn.ToLocalTime().ToString('HH:mm:ss'))). Its log: $jarvisLog"
} else {
  $task = Get-ScheduledTask -TaskName "Hearth Jarvis"
  $result = ($task | Get-ScheduledTaskInfo).LastTaskResult
  Write-Warning ("Jarvis hasn't checked in 3 minutes after its task started. The task is {0} (last result 0x{1:X})." -f $task.State, $result)
  if ("$($task.State)" -ne "Running") {
    Write-Warning "Its cmd ended. Exit 1 at once, with nothing new in the log, usually means another process holds the log."
  }
  # Read, not listed: while Jarvis has the log open, Windows' folder listing shows it as empty.
  Write-Host "The end of $jarvisLog`:"
  Get-Content -Tail 20 $jarvisLog -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $_" }
}

function Find-Chrome {
  $paths = @(foreach ($key in "HKCU:", "HKLM:", "HKLM:\SOFTWARE\WOW6432Node") {
    $appPath = if ($key -like "*WOW6432Node") { "$key\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" }
               else { "$key\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" }
    $item = Get-Item -LiteralPath $appPath -ErrorAction SilentlyContinue
    if ($item -and $item.GetValue("")) { [Environment]::ExpandEnvironmentVariables([string]$item.GetValue("")).Trim('"') }
  })
  $paths += "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
            "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
            "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  foreach ($p in $paths) {
    if ($p -and (Test-Path -LiteralPath $p -PathType Leaf)) { return (Get-Item -LiteralPath $p).FullName }
  }
  return $null
}

# The Chrome profile to open: the one the Hearth extension is loaded in, else the last one used.
function Find-ChromeProfile([string]$UserData, [string]$Extension) {
  $lastUsed = "Default"
  try {
    $state = Get-Content -Raw -LiteralPath "$UserData\Local State" | ConvertFrom-Json
    if ($state.profile.last_used) { $lastUsed = $state.profile.last_used }
  } catch {}
  # Chrome keeps an unpacked extension's folder in the profile's preferences, JSON-escaped.
  $needle = ($Extension | ConvertTo-Json).Trim('"')
  $with = @(Get-ChildItem -LiteralPath $UserData -Directory -ErrorAction SilentlyContinue | Where-Object {
    foreach ($file in "Secure Preferences", "Preferences") {
      $text = Get-Content -Raw -LiteralPath (Join-Path $_.FullName $file) -ErrorAction SilentlyContinue
      if ($text -and $text.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
    }
    $false
  } | ForEach-Object { $_.Name })
  if ($with -contains $lastUsed) { return $lastUsed }
  if ($with.Count -gt 0) { return $with[0] }
  Write-Warning "The Hearth extension isn't loaded in Chrome yet, so Hearth will open the profile you used last (`"$lastUsed`"). If you load it into another profile (docs\setup-windows.md, section 10), run this again."
  return $lastUsed
}

if (-not $SkipChromeTask) {
  $chrome = Find-Chrome
  $userData = "$env:LOCALAPPDATA\Google\Chrome\User Data"
  if (-not $chrome) {
    Write-Warning "Couldn't find Chrome, so Hearth can't open it by itself. Install Chrome, then run this again."
  } else {
    if (-not $ChromeProfile) {
      $ChromeProfile = Find-ChromeProfile $userData "$Root\apps\extension"
    } elseif (-not (Test-Path -LiteralPath (Join-Path $userData $ChromeProfile) -PathType Container)) {
      throw "Chrome has no profile folder `"$ChromeProfile`" in $userData. Check the end of Profile Path on chrome://version."
    }
    $me = "$env:USERDOMAIN\$env:USERNAME"
    # No window of its own: Chrome waits in the background until Jarvis opens a tab. If Chrome is
    # already running, this does nothing. Should the profile folder go, Chrome opens the last one
    # you used rather than making a new, empty profile.
    $action = New-ScheduledTaskAction -Execute $chrome -WorkingDirectory (Split-Path $chrome) `
      -Argument "--no-startup-window --profile-directory=`"$ChromeProfile`" --ignore-profile-directory-if-not-exists"
    $atLogOn = New-ScheduledTaskTrigger -AtLogOn -User $me
    $atLogOn.Delay = "PT20S"
    # The task lasts as long as the Chrome it opened, so: no time limit, keep going on battery,
    # and never a second copy. Chrome inherits the task's priority; 4 is the one with normal CPU,
    # disk and memory priority, like Chrome started from its icon.
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -Priority 4
    # Interactive: only while you're signed in, on your desktop, so you can see it.
    $user = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName "Hearth Chrome" -TaskPath "\" -Action $action -Trigger $atLogOn `
      -Settings $settings -Principal $user -Force `
      -Description "Opens your Chrome for Jarvis when you sign in, and when Hearth needs it." | Out-Null
    # Hearth's server runs as LocalService; let it start (read and run) this one task, nothing more.
    $scheduler = New-Object -ComObject Schedule.Service
    $scheduler.Connect()
    $task = $scheduler.GetFolder("\").GetTask("Hearth Chrome")
    $sddl = $task.GetSecurityDescriptor(7)
    if ($sddl -notmatch "\(A;[^;]*;[^;]*GX[^;]*;;;(LS|S-1-5-19)\)") {
      $task.SetSecurityDescriptor($sddl + "(A;;GRGX;;;LS)", 0)
    }
    Write-Host "Hearth can open Chrome (profile `"$ChromeProfile`") when Jarvis needs it."
    Write-Host "If the Hearth extension is in another profile, run this again with -ChromeProfile `"<its folder>`"."
  }
}

if (-not $SkipBackupTask) {
  $action = New-ScheduledTaskAction -Execute $node -WorkingDirectory $Root `
    -Argument "--env-file-if-exists=`"$Root\.env`" `"$Root\apps\cli\src\main.ts`" backup"
  $trigger = New-ScheduledTaskTrigger -Daily -At $BackupTime
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2) -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 15)
  $user = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
  Register-ScheduledTask -TaskName "Hearth backup" -Action $action -Trigger $trigger -Settings $settings `
    -Principal $user -Description "Backs up Hearth, uploads it with restic and tests a restore." -Force | Out-Null
  Write-Host "Scheduled the nightly backup at $BackupTime."
}

Write-Host ""
Write-Host "Done. Check everything with: pnpm hearth doctor"
