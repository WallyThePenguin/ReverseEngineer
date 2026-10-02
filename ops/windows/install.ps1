<#
.SYNOPSIS
  Installs Hearth's three Windows services (server, worker, Jarvis) and the nightly backup task.

.DESCRIPTION
  Run from an elevated PowerShell in the Hearth folder, after `pnpm install`, `pnpm build:web`
  and `pnpm hearth setup`. See docs/setup-windows.md.

  - hearth-server and hearth-worker run as LocalService (no password, few rights).
  - hearth-jarvis runs as your account, so it can use your Claude login. WinSW asks for your
    password once; Windows stores it, not Hearth.
  - The backup runs nightly at 2:30 a.m. as you, whether or not you're signed in.
  - The "Hearth Chrome" task opens your Chrome, as you, on your desktop: when you sign in, and
    when Jarvis needs it and it's closed (the server asks Windows to run it). Run this script from
    your own Windows account (Run as administrator), so the task is yours and finds your Chrome.
#>
[CmdletBinding()]
param(
  [string]$Root = (Resolve-Path "$PSScriptRoot\..\..").Path,
  [string]$BackupTime = "02:30",
  [switch]$SkipBackupTask,
  # Chrome's profile folder with the Hearth extension, like "Default" or "Profile 1". Chrome shows
  # it on chrome://version as the last part of "Profile Path". Defaults to the last one you used.
  [string]$ChromeProfile = "",
  [switch]$SkipChromeTask
)
$ErrorActionPreference = "Stop"

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

# LocalService needs to read the app and write its own logs.
icacls $Root /grant "*S-1-5-19:(OI)(CI)RX" /T /C /Q | Out-Null
icacls $ServiceDir /grant "*S-1-5-19:(OI)(CI)M" /C /Q | Out-Null

foreach ($svc in "server", "worker", "jarvis") {
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
  if ($svc -eq "jarvis") {
    Write-Host ""
    Write-Host "Jarvis runs as you. Enter your Windows account (like .\$env:USERNAME) and password,"
    Write-Host "then answer y to allow it to log on as a service."
    & $exe install /p
  } else {
    & $exe install
  }
  if ($LASTEXITCODE -ne 0) { throw "Installing $id failed (exit $LASTEXITCODE)." }
  & $exe start
  Write-Host "Started $id."
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

if (-not $SkipChromeTask) {
  $chrome = Find-Chrome
  if (-not $chrome) {
    Write-Warning "Couldn't find Chrome, so Hearth can't open it by itself. Install Chrome, then run this again."
  } else {
    if (-not $ChromeProfile) {
      $ChromeProfile = "Default"
      $localState = "$env:LOCALAPPDATA\Google\Chrome\User Data\Local State"
      try {
        $state = Get-Content -Raw -LiteralPath $localState | ConvertFrom-Json
        if ($state.profile.last_used) { $ChromeProfile = $state.profile.last_used }
      } catch {}
    }
    $me = "$env:USERDOMAIN\$env:USERNAME"
    # No window of its own: Chrome waits in the background until Jarvis opens a tab. If Chrome is
    # already running, this does nothing.
    $action = New-ScheduledTaskAction -Execute $chrome -WorkingDirectory (Split-Path $chrome) `
      -Argument "--no-startup-window --profile-directory=`"$ChromeProfile`""
    $atLogOn = New-ScheduledTaskTrigger -AtLogOn -User $me
    $atLogOn.Delay = "PT20S"
    # The task lasts as long as the Chrome it opened, so: no time limit, keep going on battery,
    # normal priority (Chrome inherits it), and never a second copy.
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -Priority 5
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
    if ($sddl -notmatch ";;;(LS|S-1-5-19)\)") { $task.SetSecurityDescriptor($sddl + "(A;;GRGX;;;LS)", 0) }
    Write-Host "Hearth can open Chrome (profile `"$ChromeProfile`") when Jarvis needs it."
    Write-Host "If the Hearth extension is in another profile, run this again with -ChromeProfile."
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
