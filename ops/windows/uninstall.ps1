<#
.SYNOPSIS
  Removes Hearth's services and scheduled tasks. Your database and backups are left alone.
#>
$ErrorActionPreference = "Stop"
$ServiceDir = Join-Path $env:ProgramData "Hearth\services"
foreach ($svc in "jarvis", "worker", "server") {
  $exe = Join-Path $ServiceDir "hearth-$svc.exe"
  if ((Test-Path $exe) -and (Get-Service "hearth-$svc" -ErrorAction SilentlyContinue)) {
    & $exe stopwait | Out-Null
    & $exe uninstall | Out-Null
    Write-Host "Removed hearth-$svc."
  }
}
# Removing the task leaves Chrome running if it opened it.
if (Get-ScheduledTask -TaskName "Hearth Chrome" -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName "Hearth Chrome" -Confirm:$false
  Write-Host "Removed the task that opens Chrome."
}
if (Get-ScheduledTask -TaskName "Hearth backup" -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName "Hearth backup" -Confirm:$false
  Write-Host "Removed the backup task."
}
