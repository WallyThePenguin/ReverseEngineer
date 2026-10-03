<#
.SYNOPSIS
  Removes Hearth's services and scheduled tasks. Your database and backups are left alone.
#>
$ErrorActionPreference = "Stop"
$ServiceDir = Join-Path $env:ProgramData "Hearth\services"
if (Get-ScheduledTask -TaskName "Hearth Jarvis" -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName "Hearth Jarvis"
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -match 'main\.ts"?\s+jarvis' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Unregister-ScheduledTask -TaskName "Hearth Jarvis" -Confirm:$false
  Write-Host "Removed the Jarvis task."
}
# "jarvis" covers installs from before Jarvis was a task.
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
