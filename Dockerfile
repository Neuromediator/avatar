# Avatar - single-container build.
#   Stage 1 builds the Vite/TypeScript frontend into static files.
#   Stage 2 runs the FastAPI backend (uv-managed), which serves the API plus the
#   built UI at / and /admin, and reads the owner knowledge from /app/knowledge.
# No secrets are baked in: configuration arrives at runtime as environment
# variables (docker run --env-file .env locally, Fly secrets in production).

# ---------------------------------------------------------------------------
# Stage 1: frontend build
# ---------------------------------------------------------------------------
FROM node:22-alpine AS frontend

WORKDIR /build/frontend

# Dependency layer first, so it is cached until package*.json change.
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY frontend/ ./
RUN npm run build


# ---------------------------------------------------------------------------
# Stage 2: runtime
# ---------------------------------------------------------------------------
FROM python:3.12-slim AS runtime

COPY --from=ghcr.io/astral-sh/uv:0.11.25 /uv /uvx /bin/

# Compile bytecode at build time, copy (not hardlink) packages into the venv,
# always use the image's Python rather than downloading one, and keep no uv
# cache in the image (no BuildKit cache mount, so the legacy builder works too).
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_NO_CACHE=1

# Unprivileged runtime user (created early so this layer stays cached).
RUN groupadd --system --gid 10001 app \
 && useradd --system --uid 10001 --gid app --create-home --home-dir /home/app \
            --shell /usr/sbin/nologin app

WORKDIR /app/backend

# Dependency layer: only the lockfile inputs, so app-code edits don't reinstall.
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

# Application code, owner knowledge and the built UI.
COPY backend/app /app/backend/app
COPY knowledge /app/knowledge
COPY --from=frontend /build/frontend/dist /app/frontend/dist

# Pre-compile the app code too (the runtime user cannot write __pycache__).
RUN /app/backend/.venv/bin/python -m compileall -q /app/backend/app

ENV KNOWLEDGE_DIR=/app/knowledge \
    STATIC_DIR=/app/frontend/dist \
    PORT=8000 \
    PYTHONUNBUFFERED=1 \
    PATH=/app/backend/.venv/bin:$PATH

USER 10001:10001

EXPOSE 8000

# /api/config returns 200 without touching the database. python:slim has no
# curl, so probe with the standard library (urlopen raises on non-2xx/3xx).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["python", "-c", "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:' + os.environ.get('PORT', '8000') + '/api/config', timeout=4)"]

# sh -c so $PORT expands; exec so uvicorn is PID 1 and receives SIGTERM.
# --proxy-headers / --forwarded-allow-ips: trust X-Forwarded-* from Fly's proxy
# so request.url.scheme is https in production.
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port \"${PORT:-8000}\" --proxy-headers --forwarded-allow-ips '*'"]
