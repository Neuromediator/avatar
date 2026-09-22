#!/usr/bin/env bash
# Stop and remove the Avatar Docker container (macOS / Linux).
# Safe to run repeatedly: does nothing if the container is not there.
set -euo pipefail

CONTAINER="avatar"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker was not found, so there is no '$CONTAINER' container to stop."
  exit 0
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running, so the '$CONTAINER' container is not running either. Nothing to stop."
  exit 0
fi

if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "Stopping the '$CONTAINER' container..."
  # 70 s grace (Docker's default is 10 s) is above the app's 60 s shutdown drain, so an
  # in-flight chat reply is still stored; an idle container stops almost at once.
  docker stop -t 70 "$CONTAINER" >/dev/null 2>&1 || true
  docker rm -f "$CONTAINER" >/dev/null
  echo "Stopped and removed '$CONTAINER'."
else
  echo "No '$CONTAINER' container found. Nothing to stop."
fi
