#!/usr/bin/env bash
# Build and run Avatar as a single Docker container (macOS / Linux).
#
# Stops and removes any existing "avatar" container, rebuilds the image from the
# repo root, then runs it with the root .env and waits until it is healthy.
# Works from any directory.
#
# Optional environment variables:
#   HOST_PORT       host port to publish the app on (default 8000)
#   MODEL_OVERRIDE  model for this run, overriding MODEL in .env
#                   (e.g. MODEL_OVERRIDE=openai/gpt-5.4-nano for cheap testing)
#   HEALTH_TIMEOUT  seconds to wait for the app to become healthy (default 60)
#
# Examples:
#   ./scripts/start_mac.sh
#   HOST_PORT=8080 MODEL_OVERRIDE=openai/gpt-5.4-nano ./scripts/start_mac.sh
set -euo pipefail

IMAGE="avatar"
CONTAINER="avatar"
CONTAINER_PORT=8000
HOST_PORT="${HOST_PORT:-8000}"
MODEL_OVERRIDE="${MODEL_OVERRIDE:-}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

die() {
  echo "Error: $*" >&2
  exit 1
}

container_exists() {
  docker container inspect "$CONTAINER" >/dev/null 2>&1
}

container_running() {
  [ "$(docker container inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)" = "true" ]
}

# --- Preflight -------------------------------------------------------------
command -v docker >/dev/null 2>&1 \
  || die "docker was not found. Install Docker Desktop (or Docker Engine) first."
docker info >/dev/null 2>&1 \
  || die "Docker is not running. Start Docker Desktop (or the Docker daemon) and try again."
command -v curl >/dev/null 2>&1 \
  || die "curl was not found; it is needed to check that the app came up."

[[ "$HOST_PORT" =~ ^[0-9]+$ ]] || die "HOST_PORT must be a number (got '$HOST_PORT')."
[[ "$HEALTH_TIMEOUT" =~ ^[0-9]+$ ]] || die "HEALTH_TIMEOUT must be a number of seconds (got '$HEALTH_TIMEOUT')."

[ -f "$REPO_ROOT/.env" ] \
  || die "No .env file found at $REPO_ROOT/.env. Follow the 'Setup instructions' in README.md to create it."

# --- Stop the old container ----------------------------------------------
if container_exists; then
  echo "Stopping the existing '$CONTAINER' container..."
  # 70 s grace (Docker's default is 10 s) is above the app's 60 s shutdown drain, so an
  # in-flight chat reply is still stored; an idle container stops almost at once.
  docker stop -t 70 "$CONTAINER" >/dev/null 2>&1 || true
  docker rm -f "$CONTAINER" >/dev/null
fi

# --- Build -----------------------------------------------------------------
echo "Building the '$IMAGE' image (this can take a few minutes the first time)..."
docker build -t "$IMAGE" "$REPO_ROOT"

# --- Run -------------------------------------------------------------------
run_args=(
  -d
  --name "$CONTAINER"
  -p "${HOST_PORT}:${CONTAINER_PORT}"
  --env-file "$REPO_ROOT/.env"
  # Pin the in-container port so a PORT in .env can't break the port mapping.
  -e "PORT=${CONTAINER_PORT}"
  # Same 70 s grace for a plain `docker stop` or Docker Desktop's Stop button
  # (above the app's 60 s shutdown drain; an idle container still stops at once).
  --stop-timeout 70
)
if [ -n "$MODEL_OVERRIDE" ]; then
  run_args+=(-e "MODEL=${MODEL_OVERRIDE}")
fi

echo "Starting the '$CONTAINER' container on port $HOST_PORT..."
docker run "${run_args[@]}" "$IMAGE" >/dev/null

# --- Wait until healthy ----------------------------------------------------
BASE_URL="http://localhost:${HOST_PORT}"
echo "Waiting for $BASE_URL/api/config (up to ${HEALTH_TIMEOUT}s)..."
deadline=$((SECONDS + HEALTH_TIMEOUT))
until curl -fsS -o /dev/null --max-time 3 "$BASE_URL/api/config" 2>/dev/null; do
  if ! container_running; then
    echo >&2
    echo "Error: the '$CONTAINER' container stopped while starting. Its logs:" >&2
    docker logs --tail 200 "$CONTAINER" >&2 || true
    exit 1
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo >&2
    echo "Error: the app did not become healthy within ${HEALTH_TIMEOUT}s. Container logs:" >&2
    docker logs --tail 200 "$CONTAINER" >&2 || true
    exit 1
  fi
  sleep 1
done

echo
echo "Avatar is running."
echo "  Visitor chat:  $BASE_URL/"
echo "  Admin:         $BASE_URL/admin"
if [ -n "$MODEL_OVERRIDE" ]; then
  echo "  Model:         $MODEL_OVERRIDE (override)"
fi
echo "  Logs:          docker logs -f $CONTAINER"
echo "  Stop:          ./scripts/stop_mac.sh"
