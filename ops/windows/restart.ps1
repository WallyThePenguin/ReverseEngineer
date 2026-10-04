<#
.SYNOPSIS
  Restarts Hearth's server, worker, Jarvis, or all three, from your own account.

.DESCRIPTION
  `pnpm hearth restart [server|worker|jarvis|all]` runs this. It uses the rights install.ps1 gave
  your account and the same stop logic as update.ps1 (Jarvis's pid file, then the task), starts
  what it stopped, and waits until that reports in: the server answering with its database fitting
  the code, the worker and Jarvis checking in. Exit code 0 means it's back.
#>
[CmdletBinding()]
param(
  [ValidateSet("server", "worker", "jarvis", "all")]
  [string]$Service = "all",
  [string]$Root = (Resolve-Path "$PSScriptRoot\..\..").Path,
  [int]$TimeoutSec = 120
)
$ErrorActionPreference = "Stop"
. "$PSScriptRoot\control.ps1"
$parts = Resolve-HearthParts $Service
$name = if ($Service -eq "all") { "Hearth" } else { "Hearth's $Service" }

try {
  Stop-Hearth $parts
  $since = [datetime]::UtcNow.AddSeconds(-5)
  Start-Hearth $parts
} catch {
  Write-Host "Couldn't restart ${name}: $_"
  Write-Host "If Windows said access is denied, run ops\windows\install.ps1 again as administrator: it lets your account restart Hearth."
  exit 1
}

Write-Host "Waiting for $name to report in..."
$why = Wait-Hearth -Since $since -Parts $parts -TimeoutSec $TimeoutSec
if ($why) {
  Write-Host "Restarted $name, but after $TimeoutSec seconds $why. Run pnpm hearth doctor to see why."
  exit 1
}
Write-Host "$name is back up."
exit 0
