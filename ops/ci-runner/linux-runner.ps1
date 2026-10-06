<#
  Hearth's Linux CI runner on this PC: a Docker Desktop container from ops\ci-runner\linux (D66,
  docs\ci.md). Run by the owner, unelevated, in Windows PowerShell or PowerShell 7:

    powershell -File ops\ci-runner\linux-runner.ps1 -Build    build the image (a few minutes)
    powershell -File ops\ci-runner\linux-runner.ps1 -Start    start it (registers it the first time)
    powershell -File ops\ci-runner\linux-runner.ps1 -Stop     stop and remove the container
    powershell -File ops\ci-runner\linux-runner.ps1 -Status   is it up, and what is it using

  The container gets 4 CPUs, 8 GB of memory, no published ports, no Docker socket and none of the
  PC's drives. Its registration and work live in two named volumes, so -Stop then -Start (after a
  -Build, say) needs no new token. The first -Start asks GitHub for a registration token with gh
  (you must be signed in: gh auth status) and hands it to the container without showing it.
#>
param(
  [switch]$Build,
  [switch]$Start,
  [switch]$Stop,
  [switch]$Status
)
$ErrorActionPreference = "Stop"

$Repo = "WallyThePenguin/ReverseEngineer"
$Image = "hearth-ci-linux"
$Tag = "2.337.0"
$Name = "hearth-ci-linux"
$RunnerName = "hearth-pc-linux"
$ConfigVolume = "hearth-ci-linux-config"
$WorkVolume = "hearth-ci-linux-work"

# Windows PowerShell turns a native program's stderr into errors that "Stop" ends the script on;
# docker writes progress there. Its exit code says whether it worked.
function Invoke-Docker {
  $ErrorActionPreference = "Continue"
  & docker @args
  if ($LASTEXITCODE -ne 0) { throw "docker $($args[0]) failed (exit $LASTEXITCODE)." }
}

function Get-State {
  $ErrorActionPreference = "Continue"
  $state = & docker ps -a --filter "name=^/$Name$" --format "{{.State}}" 2>$null
  if ($LASTEXITCODE -ne 0) { throw "Docker isn't answering. Start Docker Desktop first." }
  return "$state".Trim()
}

function Test-Registered {
  $ErrorActionPreference = "Continue"
  # Asks the image itself whether the config volume holds a registration (nothing else pulled).
  & docker run --rm --entrypoint test -v "${ConfigVolume}:/home/runner/config" "${Image}:$Tag" -f /home/runner/config/.runner 2>$null
  return $LASTEXITCODE -eq 0
}

if (-not ($Build -or $Start -or $Stop -or $Status)) {
  Write-Host "Say what to do: -Build, -Start, -Stop or -Status."
  exit 2
}

if ($Build) {
  $context = Join-Path $PSScriptRoot "linux"
  Invoke-Docker build --pull -t "${Image}:$Tag" -t "${Image}:latest" $context
  $size = & docker image inspect "${Image}:$Tag" --format "{{.Size}}"
  Write-Host ("Built {0}:{1}, {2:N1} GB." -f $Image, $Tag, ([double]$size / 1GB))
}

if ($Stop) {
  if (Get-State) {
    Write-Host "Stopping $Name (a job it's running ends unfinished; run it again from GitHub)."
    Invoke-Docker stop --time 30 $Name | Out-Null
    Invoke-Docker rm $Name | Out-Null
  }
  Write-Host "Stopped. Its registration and work are kept in $ConfigVolume and $WorkVolume."
}

if ($Start) {
  $state = Get-State
  if ($state -eq "running") {
    Write-Host "$Name is already running."
  } elseif ($state) {
    Invoke-Docker start $Name | Out-Null
    Write-Host "Started $Name again."
  } else {
    $ErrorActionPreference = "Continue"
    & docker image inspect "${Image}:$Tag" *> $null
    $built = $LASTEXITCODE -eq 0
    $ErrorActionPreference = "Stop"
    if (-not $built) { throw "There's no ${Image}:$Tag image yet. Build it first: -Build." }
    $token = $null
    if (-not (Test-Registered)) {
      $token = & gh api -X POST "repos/$Repo/actions/runners/registration-token" --jq .token
      if ($LASTEXITCODE -ne 0 -or -not $token) { throw "Couldn't get a registration token. Is gh signed in (gh auth status)?" }
    }
    try {
      # -e RUNNER_TOKEN with no value copies it from this process: never on a command line.
      $env:RUNNER_TOKEN = $token
      Invoke-Docker run -d --name $Name --restart unless-stopped `
        --cpus 4 --memory 8g --memory-swap 8g --shm-size 1g `
        --add-host "host.docker.internal:127.0.0.1" --add-host "gateway.docker.internal:127.0.0.1" `
        -e RUNNER_TOKEN -e "RUNNER_NAME=$RunnerName" -e "RUNNER_URL=https://github.com/$Repo" `
        -v "${ConfigVolume}:/home/runner/config" -v "${WorkVolume}:/home/runner/_work" `
        "${Image}:$Tag" | Out-Null
    } finally {
      Remove-Item Env:\RUNNER_TOKEN -ErrorAction SilentlyContinue
      $token = $null
    }
    Write-Host "Started $Name. It shows up as $RunnerName under the repo's Settings > Actions > Runners."
  }
}

if ($Status) {
  $ErrorActionPreference = "Continue"
  $state = Get-State
  if (-not $state) {
    Write-Host "$Name isn't there. Build it with -Build, then -Start."
  } else {
    & docker ps -a --filter "name=^/$Name$" --format "{{.Names}}: {{.Status}} ({{.Image}})"
    if ($state -eq "running") {
      & docker stats --no-stream --format "CPU {{.CPUPerc}} of 400%, memory {{.MemUsage}}" $Name
    }
    Write-Host "Last lines of its log:"
    & docker logs --tail 8 $Name 2>&1 | ForEach-Object { "  $_" }
  }
}
