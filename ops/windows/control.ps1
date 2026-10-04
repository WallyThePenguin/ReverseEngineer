<#
  Stopping, starting and checking Hearth, shared by update.ps1 and restart.ps1, which dot-source
  this file; it only defines functions. They run unelevated once install.ps1 has given your
  account the rights to Hearth's two services and the "Hearth Jarvis" task. They read $Root, the
  Hearth folder, from the script that dot-sources them.
#>

function Get-EnvValue([string]$Name) {
  if (-not (Test-Path "$Root\.env")) { return $null }
  $line = Get-Content "$Root\.env" | Where-Object { $_ -match "^$Name=" } | Select-Object -First 1
  if ($line) { return ($line -replace "^$Name=", "").Trim() }
  return $null
}

function Get-HearthPort {
  $port = Get-EnvValue "HEARTH_PORT"
  if ($port) { return $port }
  return "4400"
}

# Which of server, worker and jarvis a name means.
function Resolve-HearthParts([string]$Which) {
  if ($Which -eq "all") { return @("server", "worker", "jarvis") }
  return @($Which)
}

function Stop-Jarvis {
  # Jarvis runs under cmd in the task; stopping the task ends cmd but not always the node under
  # it, and an unelevated account can't read session-0 command lines. So: the pid Jarvis wrote at
  # startup, plus every child of the task's running process.
  $pids = @()
  $pidFile = "$env:ProgramData\Hearth\services\hearth-jarvis.pid"
  if (Test-Path $pidFile) { $pids += [int](Get-Content $pidFile -Raw).Trim() }
  $scheduler = New-Object -ComObject Schedule.Service
  $scheduler.Connect()
  $task = $scheduler.GetFolder("\").GetTask("Hearth Jarvis")
  foreach ($run in @($task.GetInstances(0))) {
    $pids += @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($run.EnginePID)" |
      Where-Object { $_.Name -eq "node.exe" } | ForEach-Object { $_.ProcessId })
  }
  Stop-ScheduledTask -TaskName "Hearth Jarvis" -ErrorAction SilentlyContinue
  foreach ($p in ($pids | Select-Object -Unique)) {
    $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -eq "node") { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
  }
}

function Stop-Hearth([string[]]$Parts = @("server", "worker", "jarvis")) {
  Write-Host "== Stopping Hearth ($($Parts -join ', '))"
  if ($Parts -contains "jarvis") { Stop-Jarvis }
  $services = @($Parts | Where-Object { $_ -ne "jarvis" } | ForEach-Object { "hearth-$_" })
  if ($services.Count) { Stop-Service $services }
}

function Start-Hearth([string[]]$Parts = @("server", "worker", "jarvis")) {
  Write-Host "== Starting Hearth ($($Parts -join ', '))"
  $services = @($Parts | Where-Object { $_ -ne "jarvis" } | ForEach-Object { "hearth-$_" })
  if ($services.Count) { Start-Service $services }
  if ($Parts -contains "jarvis") { Start-ScheduledTask -TaskName "Hearth Jarvis" }
}

# Waits for the server to answer /api/health, up to a minute.
function Test-Hearth {
  $port = Get-HearthPort
  for ($i = 0; $i -lt 30; $i++) {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 "http://127.0.0.1:$port/api/health"
      if ($r.StatusCode -eq 200) { return $true }
    } catch {}
    Start-Sleep -Seconds 2
  }
  return $false
}

# The server's own report (GET /api/health/deep, which answers programs on this PC). Status is the
# HTTP status, 0 when it doesn't answer; Body the report when it's 200.
function Get-DeepHealth {
  try {
    $body = Invoke-RestMethod -UseBasicParsing -TimeoutSec 5 "http://127.0.0.1:$(Get-HearthPort)/api/health/deep"
    return [pscustomobject]@{ Status = 200; Body = $body }
  } catch {
    $code = 0
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    return [pscustomobject]@{ Status = $code; Body = $null }
  }
}

function ConvertTo-UtcTime($Value) {
  if ($null -eq $Value -or "$Value" -eq "") { return [datetime]::MinValue }
  if ($Value -is [datetime]) { return $Value.ToUniversalTime() }
  return [datetime]::Parse([string]$Value, [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::AdjustToUniversal)
}

function Format-Sha([string]$Sha) {
  if ($Sha -and $Sha.Length -ge 7) { return $Sha.Substring(0, 7) }
  return "an unknown build"
}

# What's still wrong with a deep health report, or $null once everything in $Parts is up: the
# server on $Sha (when given) with its database fitting the code, started after $Since, and the
# worker and Jarvis reporting in since $Since, not failing.
function Get-DeepProblem($Deep, [datetime]$Since, [string]$Sha, [string[]]$Parts) {
  if ($Parts -contains "server") {
    if ($Sha -and $Deep.sha -ne $Sha) {
      return "the server runs $(Format-Sha $Deep.sha), not $(Format-Sha $Sha)"
    }
    if (-not $Deep.db -or -not $Deep.db.ok) { return "the server can't reach the database" }
    if (-not $Deep.migrations -or -not $Deep.migrations.ok) {
      return "the database doesn't fit the code ($($Deep.problems -join '; '))"
    }
    if ((ConvertTo-UtcTime $Deep.startedAt) -lt $Since) { return "the server hasn't restarted" }
  }
  foreach ($part in @("worker", "jarvis")) {
    if ($Parts -notcontains $part) { continue }
    $c = $Deep.components.$part
    if (-not $c -or (ConvertTo-UtcTime $c.at) -lt $Since) { return "the $part hasn't reported in since it started" }
    if ($c.status -eq "failing") { return "the $part says: $($c.detail)" }
  }
  return $null
}

# Waits until Get-DeepProblem finds nothing; returns $null then, or the last problem when time's
# up. -AllowOld accepts a server from before deep health (it answers 404): going back to old code.
function Wait-Hearth {
  param(
    [datetime]$Since,
    [string]$Sha = "",
    [string[]]$Parts = @("server", "worker", "jarvis"),
    [int]$TimeoutSec = 180,
    [switch]$AllowOld
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $why = "the server isn't answering"
  while ($true) {
    $deep = Get-DeepHealth
    if ($deep.Status -eq 200) {
      $why = Get-DeepProblem $deep.Body $Since $Sha $Parts
      if (-not $why) { return $null }
    } elseif ($deep.Status -eq 404) {
      if ($AllowOld) { return $null }
      $why = "the server is still the old one (no /api/health/deep)"
    } elseif ($deep.Status) {
      $why = "the server answers HTTP $($deep.Status)"
    }
    if ((Get-Date) -ge $deadline) { return $why }
    Start-Sleep -Seconds 3
  }
}

# `hearth doctor`'s checks: Checks from --json, or, from a doctor before --json, its Text.
function Get-DoctorReport {
  $out = pnpm --silent hearth doctor --json | Out-String
  try { $json = $out | ConvertFrom-Json } catch { $json = $null }
  if ($json -and $null -ne $json.checks) { return [pscustomobject]@{ Checks = @($json.checks); Text = $null } }
  return [pscustomobject]@{ Checks = $null; Text = $out }
}

# How a check came out in an earlier doctor report: ok, warn, fail, or $null if it wasn't there.
# Names match exactly ("Server" the HTTP check isn't "server" the component); should two checks
# share a name, the worse mark counts, so a failure from before is never taken for a new one.
function Get-DoctorMark($Report, [string]$Name) {
  if (-not $Report) { return $null }
  if ($Report.Checks) {
    $marks = @($Report.Checks | Where-Object { $_.name -ceq $Name } | ForEach-Object { $_.mark })
    foreach ($m in @("fail", "warn", "ok")) { if ($marks -contains $m) { return $m } }
    return $null
  }
  # The text doctor prints "<mark> <name, padded> <detail>": a check mark (U+2713) for ok, ! for
  # warn, a cross (U+2717) for fail. Needs the console reading UTF-8 (update.ps1 sets it).
  foreach ($line in ("$($Report.Text)" -split "`r?`n")) {
    if ($line.Length -lt 3 -or -not $line.Substring(2).StartsWith("$Name ")) { continue }
    if ($line[0] -eq [char]0x2713) { return "ok" }
    if ($line[0] -eq "!") { return "warn" }
    if ($line[0] -eq [char]0x2717) { return "fail" }
  }
  return $null
}

# Sorts what fails after an update: New failed after but not before (the update broke it), Old
# failed before too, Unknown is a check the doctor before didn't have, so it can't tell.
function Compare-Doctor($Before, $After) {
  $result = [pscustomobject]@{ New = @(); Old = @(); Unknown = @() }
  foreach ($c in @($After.Checks | Where-Object { $_.mark -eq "fail" })) {
    $was = Get-DoctorMark $Before $c.name
    if ($was -eq "fail") { $result.Old += $c }
    elseif ($was) { $result.New += $c }
    else { $result.Unknown += $c }
  }
  return $result
}
