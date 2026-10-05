<#
.SYNOPSIS
  Restarts Hearth's server, worker, Jarvis, or all three, from your own account.

.DESCRIPTION
  `pnpm hearth restart [server|worker|jarvis|all]` runs this. It uses the rights install.ps1 gave
  your account and the same stop logic as update.ps1 (asking Jarvis to stop, then ending its task,
  then waiting for it to go), starts what it stopped, and waits until that reports in: the server
  answering with its database fitting the code, the worker and Jarvis checking in. A Jarvis that
  won't stop leaves everything as it was, with the pid to end. Exit code 0 means it's back.
#>
[CmdletBinding()]
param(
  [ValidateSet("server", "worker", "jarvis", "all")]
  [string]$Service = "all",
  # Hearth's folder; by default the one this script is in.
  [string]$Root,
  [int]$TimeoutSec = 120
)
$ErrorActionPreference = "Stop"
# Not as the parameter's default: Windows PowerShell leaves $PSScriptRoot empty there for a script
# run with -File, as `hearth restart` runs this.
if (-not $Root) { $Root = (Resolve-Path "$PSScriptRoot\..\..").Path }
. "$PSScriptRoot\control.ps1"
$parts = Resolve-HearthParts $Service
$name = if ($Service -eq "all") { "Hearth" } else { "Hearth's $Service" }

# What was failing already (Jarvis's last turn, say) only has to report in again afterwards.
$failed = Get-FailingParts (Get-DeepHealth).Body

try {
  Stop-Hearth $parts
  # Once it's all stopped, with no margin: a report from just before the stop must not count as
  # the new one checking in.
  $since = [datetime]::UtcNow
  Start-Hearth $parts
} catch {
  Write-Host "Couldn't restart ${name}: $_"
  # A Jarvis that won't stop (Stop-Jarvis) says what to do itself.
  if ("$_" -notmatch "older Jarvis|Jarvis's log") {
    Write-Host "If Windows said access is denied, run ops\windows\install.ps1 again as administrator: it lets your account restart Hearth."
  }
  exit 1
}

Write-Host "Waiting for $name to report in..."
$why = Wait-Hearth -Since $since -Parts $parts -TimeoutSec $TimeoutSec -Failed $failed
if ($why) {
  Write-Host "Restarted $name, but after $TimeoutSec seconds $why. Run pnpm hearth doctor to see why."
  exit 1
}
Write-Host "$name is back up."
exit 0
