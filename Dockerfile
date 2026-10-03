# The release image: the API with the browser client's static export inside it.
#
# One image, and at the repository root rather than under a tree, because it
# is built from both trees: the frontend stage produces the export and the
# backend stage packages it into the wheel (ADR-0008). There is
# no Next server to run, so there is no second container.
#   docker build -t reposhape:<release> .
# `just release-build` is the supported entrypoint.
#
# Base images are pinned by DIGEST rather than tag: a tag is a moving pointer,
# and the same Dockerfile would build different images on different days. A
# base moves when someone changes a digest here, on purpose.

# node:24-bookworm-slim
FROM node@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7 AS web

WORKDIR /build

# Pinned here because nothing else pins it: this workspace has no root
# package.json for corepack to read a `packageManager` field from. Same version
# SPEC's stack table records for the host.
RUN corepack enable && corepack prepare pnpm@11.15.1 --activate

# Manifests and lockfile first, so a source edit does not reinstall everything.
# `--frozen-lockfile` refuses to update the lockfile, so the image can only
# contain the reviewed dependency set.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY frontend/package.json ./frontend/
RUN --mount=type=cache,target=/pnpm-store \
    pnpm install --frozen-lockfile --store-dir /pnpm-store

COPY frontend ./frontend
COPY tools/third_party_notices.mjs ./tools/
RUN cd frontend && REPOSHAPE_WEB_EXPORT=1 pnpm exec next build \
    && node ../tools/third_party_notices.mjs out/THIRD_PARTY_NOTICES.txt

# ghcr.io/astral-sh/uv:python3.14-bookworm-slim
FROM ghcr.io/astral-sh/uv@sha256:7cf77f594be8042dab6daa9fe326f90962252268b4f120a7f5dccce4d947e6c1 AS builder

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never

# The builder's WORKDIR must match the runtime's: a virtualenv's console scripts
# carry an absolute shebang, so a venv built elsewhere and copied to /app/.venv
# dies at exec naming an interpreter that does not exist.
WORKDIR /app

COPY backend/pyproject.toml backend/uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --no-install-project

# graphify, for the comparison tabs on the curated repos. Its own virtualenv,
# because it pins tree-sitter below 0.26 and this app runs 0.26. Installed from
# a hashed lock with no extras, so no LLM client is in the image
# (ops/graphify/requirements.in says why).
COPY ops/graphify/requirements.txt /tmp/graphify-requirements.txt
RUN --mount=type=cache,target=/root/.cache/uv \
    uv venv /opt/graphify \
    && uv pip install --python /opt/graphify/bin/python \
       --require-hashes --only-binary :all: -r /tmp/graphify-requirements.txt

COPY backend/src ./src
# What building the project itself reads: its README and license for the
# metadata, and the hook that refuses a package with no page in it.
COPY backend/README.md backend/LICENSE backend/hatch_build.py ./
# Where `web_bundle.BUNDLE_DIR` looks, and what the wheel's `artifacts` line
# packages. Without it the image serves an API with no page in front of it.
COPY --from=web /build/frontend/out ./src/reposhape/web

# `--no-editable`: the runtime stage copies the virtualenv without /app/src, so
# an editable install would import nothing.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --no-editable

# python:3.14-slim-bookworm
FROM python@sha256:86f975aca15cf04a40b399eebede9aea7c82eae084d1f1a0a6ef6bcaae871a30 AS runtime

ARG SOURCE_COMMIT
ARG APPLICATION_RELEASE
ARG BUILD_TIMESTAMP
LABEL org.opencontainers.image.title="reposhape" \
      org.opencontainers.image.description="File-level import graph of a repository: the API and its static browser client." \
      org.opencontainers.image.revision="${SOURCE_COMMIT}" \
      org.opencontainers.image.version="${APPLICATION_RELEASE}" \
      org.opencontainers.image.created="${BUILD_TIMESTAMP}"

# git, which a slim Python image does not carry and this one cannot run without:
# scanning lists a repo's files with `git ls-files`, and `reposhape clone` is how the
# operator puts a curated repo on the volume.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# The two roots are the two named volumes compose mounts (ADR-0007: a clone is
# data, not cache). Set here so the image cannot start pointed anywhere else.
ENV PATH=/app/.venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    REPOSHAPE_CACHE_ROOT=/data/cache \
    REPOSHAPE_CLONE_ROOT=/data/clones

WORKDIR /app

# Unprivileged from here on. The volume mount points are created and owned in
# the image because a named volume takes its first ownership from the directory
# it is mounted over; created by Docker instead, they would be root's and every
# clone would fail with permission denied.
RUN groupadd --system --gid 1001 reposhape \
    && useradd --system --uid 1001 --gid reposhape --home-dir /data \
       --no-create-home --shell /usr/sbin/nologin reposhape \
    && mkdir -p /data/cache /data/clones \
    && chown -R reposhape:reposhape /data

COPY --from=builder --chown=reposhape:reposhape /app/.venv /app/.venv
# Root-owned: nothing at runtime writes to graphify's install. Linked rather
# than put on PATH, so its interpreter never shadows the app's.
COPY --from=builder /opt/graphify /opt/graphify
RUN ln -s /opt/graphify/bin/graphify /usr/local/bin/graphify

USER reposhape

EXPOSE 8000

# Straight uvicorn rather than `reposhape serve`, for two reasons:
# `--no-proxy-headers` so nothing trusts a forwarded address it cannot verify,
# and one worker because the graph memo lives in the process. Read-only or not
# is the environment's decision (`REPOSHAPE_READ_ONLY`), not the image's.
CMD ["uvicorn", "reposhape.api:app", \
     "--host", "0.0.0.0", \
     "--port", "8000", \
     "--workers", "1", \
     "--no-proxy-headers", \
     "--timeout-graceful-shutdown", "5"]
