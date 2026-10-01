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
#>
[CmdletBinding()]
param(
  [string]$Root = (Resolve-Path "$PSScriptRoot\..\..").Path,
  [string]$BackupTime = "02:30",
  [switch]$SkipBackupTask
)
$ErrorActionPreference = "Stop"

$WinSWVersion = "v2.12.0"
$WinSWSha256 = "05B82D46AD331CC16BDC00DE5C6332C1EF818DF8CEEFCD49C726553209B3A0DA"
$ServiceDir = Join-Path $env:ProgramData "Hearth\services"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this from an elevated PowerShell (Run as administrator)."
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
