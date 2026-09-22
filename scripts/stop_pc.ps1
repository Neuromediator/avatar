<#
.SYNOPSIS
  Stop and remove the Avatar Docker container (Windows).

.DESCRIPTION
  Safe to run repeatedly: does nothing if the container is not there.
#>
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Container = 'avatar'

# Run docker with the given arguments, discarding all output; returns $true on exit code 0.
# ErrorActionPreference is relaxed so stderr from docker never becomes a terminating error.
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

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Host "docker was not found, so there is no '$Container' container to stop."
    exit 0
}

if (-not (Test-Docker @('info'))) {
    Write-Host "Docker is not running, so the '$Container' container is not running either. Nothing to stop."
    exit 0
}

if (Test-Docker @('container', 'inspect', $Container)) {
    Write-Host "Stopping the '$Container' container..."
    # 70 s grace (Docker's default is 10 s) is above the app's 60 s shutdown drain, so an
    # in-flight chat reply is still stored; an idle container stops almost at once.
    $null = Test-Docker @('stop', '-t', '70', $Container)
    if (-not (Test-Docker @('rm', '-f', $Container))) {
        Write-Host "Error: could not remove the '$Container' container." -ForegroundColor Red
        exit 1
    }
    Write-Host "Stopped and removed '$Container'."
}
else {
    Write-Host "No '$Container' container found. Nothing to stop."
}
