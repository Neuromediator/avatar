<#
.SYNOPSIS
  Build and run Avatar as a single Docker container (Windows).

.DESCRIPTION
  Stops and removes any existing "avatar" container, rebuilds the image from the
  repo root, then runs it with the root .env and waits until it is healthy.
  Works from any directory.

  Optional environment variables:
    HOST_PORT       host port to publish the app on (default 8000)
    MODEL_OVERRIDE  model for this run, overriding MODEL in .env
                    (e.g. openai/gpt-5.4-nano for cheap testing)
    HEALTH_TIMEOUT  seconds to wait for the app to become healthy (default 60)

.EXAMPLE
  ./scripts/start_pc.ps1

.EXAMPLE
  $env:HOST_PORT = '8080'; $env:MODEL_OVERRIDE = 'openai/gpt-5.4-nano'; ./scripts/start_pc.ps1
#>
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Image = 'avatar'
$Container = 'avatar'
$ContainerPort = 8000
$HostPort = if ($env:HOST_PORT) { $env:HOST_PORT } else { '8000' }
$ModelOverride = if ($env:MODEL_OVERRIDE) { $env:MODEL_OVERRIDE } else { '' }
$HealthTimeoutRaw = if ($env:HEALTH_TIMEOUT) { $env:HEALTH_TIMEOUT } else { '60' }

# A plain filesystem path for docker. Resolve-Path's .Path would carry PowerShell's provider
# prefix ("Microsoft.PowerShell.Core\FileSystem::") and an uncollapsed ".." when the repo is on a
# UNC path, e.g. a WSL checkout run from Windows (\\wsl.localhost\...), and docker rejects it.
$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$EnvFile = Join-Path $RepoRoot '.env'

function Stop-WithError([string]$Message) {
    Write-Host "Error: $Message" -ForegroundColor Red
    exit 1
}

# Run docker with the given arguments, discarding all output; returns $true on exit code 0.
# ErrorActionPreference is relaxed so stderr from docker never becomes a terminating error
# (Windows PowerShell 5.1 turns redirected native stderr into error records).
function Test-Docker([string[]]$DockerArgs) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & docker @DockerArgs *> $null
        return ($LASTEXITCODE -eq 0)
    }
    catch {
        return $false
    }
    finally {
        $ErrorActionPreference = $prev
    }
}

# Run docker with the given arguments, showing its output; fails the script on a non-zero exit code.
function Invoke-Docker([string[]]$DockerArgs, [string]$FailureMessage) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & docker @DockerArgs | Out-Host
        $code = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $prev
    }
    if ($code -ne 0) { Stop-WithError "$FailureMessage (docker exit code $code)" }
}

function Test-ContainerExists {
    return (Test-Docker @('container', 'inspect', $Container))
}

function Test-ContainerRunning {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $state = & docker container inspect -f '{{.State.Running}}' $Container 2> $null
        return (($LASTEXITCODE -eq 0) -and ("$state".Trim() -eq 'true'))
    }
    catch {
        return $false
    }
    finally {
        $ErrorActionPreference = $prev
    }
}

function Show-ContainerLogs {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & docker logs --tail 200 $Container 2>&1 | ForEach-Object { "$_" } | Out-Host
    }
    catch { }
    finally {
        $ErrorActionPreference = $prev
    }
}

# --- Preflight -------------------------------------------------------------
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Stop-WithError 'docker was not found. Install Docker Desktop first.'
}
if (-not (Test-Docker @('info'))) {
    Stop-WithError 'Docker is not running. Start Docker Desktop and try again.'
}
if ($HostPort -notmatch '^\d+$') {
    Stop-WithError "HOST_PORT must be a number (got '$HostPort')."
}
if ($HealthTimeoutRaw -notmatch '^\d+$') {
    Stop-WithError "HEALTH_TIMEOUT must be a number of seconds (got '$HealthTimeoutRaw')."
}
$HealthTimeout = [int]$HealthTimeoutRaw
if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) {
    Stop-WithError "No .env file found at $EnvFile. Follow the 'Setup instructions' in README.md to create it."
}

# --- Stop the old container ----------------------------------------------
if (Test-ContainerExists) {
    Write-Host "Stopping the existing '$Container' container..."
    # 70 s grace (Docker's default is 10 s) is above the app's 60 s shutdown drain, so an
    # in-flight chat reply is still stored; an idle container stops almost at once.
    $null = Test-Docker @('stop', '-t', '70', $Container)
    if (-not (Test-Docker @('rm', '-f', $Container))) {
        Stop-WithError "Could not remove the existing '$Container' container."
    }
}

# --- Build -----------------------------------------------------------------
Write-Host "Building the '$Image' image (this can take a few minutes the first time)..."
Invoke-Docker @('build', '-t', $Image, $RepoRoot) 'The image build failed'

# --- Run -------------------------------------------------------------------
$runArgs = @(
    'run', '-d',
    '--name', $Container,
    '-p', "${HostPort}:${ContainerPort}",
    '--env-file', $EnvFile,
    # Pin the in-container port so a PORT in .env can't break the port mapping.
    '-e', "PORT=$ContainerPort",
    # Same 70 s grace for a plain `docker stop` or Docker Desktop's Stop button
    # (above the app's 60 s shutdown drain; an idle container still stops at once).
    '--stop-timeout', '70'
)
if ($ModelOverride) {
    $runArgs += @('-e', "MODEL=$ModelOverride")
}
$runArgs += $Image

Write-Host "Starting the '$Container' container on port $HostPort..."
if (-not (Test-Docker $runArgs)) {
    Stop-WithError "Could not start the '$Container' container (is port $HostPort already in use?)."
}

# --- Wait until healthy ----------------------------------------------------
$BaseUrl = "http://localhost:$HostPort"
Write-Host "Waiting for $BaseUrl/api/config (up to ${HealthTimeout}s)..."
$deadline = (Get-Date).AddSeconds($HealthTimeout)
$healthy = $false
while ($true) {
    try {
        $resp = Invoke-WebRequest -Uri "$BaseUrl/api/config" -UseBasicParsing -TimeoutSec 3
        if ($resp.StatusCode -eq 200) { $healthy = $true; break }
    }
    catch { }

    if (-not (Test-ContainerRunning)) {
        Write-Host ''
        Write-Host "Error: the '$Container' container stopped while starting. Its logs:" -ForegroundColor Red
        Show-ContainerLogs
        exit 1
    }
    if ((Get-Date) -ge $deadline) { break }
    Start-Sleep -Seconds 1
}

if (-not $healthy) {
    Write-Host ''
    Write-Host "Error: the app did not become healthy within ${HealthTimeout}s. Container logs:" -ForegroundColor Red
    Show-ContainerLogs
    exit 1
}

Write-Host ''
Write-Host 'Avatar is running.' -ForegroundColor Green
Write-Host "  Visitor chat:  $BaseUrl/"
Write-Host "  Admin:         $BaseUrl/admin"
if ($ModelOverride) {
    Write-Host "  Model:         $ModelOverride (override)"
}
Write-Host "  Logs:          docker logs -f $Container"
Write-Host '  Stop:          ./scripts/stop_pc.ps1'
