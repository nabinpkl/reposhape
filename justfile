# The one task surface.

default:
    @just --list

# Analyse a repo and write the JSON artifact into the cache.
analyze repo:
    cd backend && uv run reposhape analyze-repo {{repo}}

# Clustered summary of a cached analysis, without a browser.
view repo *args:
    cd backend && uv run reposhape view {{repo}} {{args}}

# Clone a repo from a git URL into the durable clone root, and analyse it.
clone url:
    cd backend && uv run reposhape clone {{url}}

# Cached analyses, newest first.
repos:
    cd backend && uv run reposhape repos

# Take a repo out of the cache, every source. The repo itself is untouched.
forget repo:
    cd backend && uv run reposhape forget {{repo}}

# The API the browser client talks to.
serve *args:
    cd backend && uv run reposhape serve --reload {{args}}

# Everything, for the repo you are standing in: analyse it, make sure the
# background server is running, open its graph. This is the daily command; the
# recipes above are its pieces. Once installed, `reposhape up` alone opens the picker.
up repo=invocation_directory() *args:
    cd backend && uv run reposhape up {{repo}} {{args}}

# The background server: where it is, and stopping it (ADR-0010).
status:
    cd backend && uv run reposhape status

down:
    cd backend && uv run reposhape down

# Put `reposhape` on PATH as a uv tool, page included, so `reposhape up` works from any
# directory. Re-run after pulling; the next `reposhape up` replaces a server still
# running the old build.
install: web-export
    uv tool install --force --reinstall --from ./backend reposhape

# The frontend's own dev server, with hot reload, proxying /api to `just serve`.
web *args:
    cd frontend && pnpm dev {{args}}

# Build the browser client as static files and put them in the Python package,
# where `reposhape up`, `reposhape serve` and the wheel all find them. Run after changing the
# frontend; `reposhape up` warns when the copy is older than frontend/src.
web-export:
    cd frontend && REPOSHAPE_WEB_EXPORT=1 pnpm exec next build
    node tools/third_party_notices.mjs frontend/out/THIRD_PARTY_NOTICES.txt
    rsync -a --delete frontend/out/ backend/src/reposhape/web/

# The wheel and sdist PyPI gets, page and notices included, built fresh into
# dist/ (ADR-0012).
package: web-export
    rm -rf dist
    cd backend && uv build --out-dir ../dist

# Install each built distribution the way a user would and drive it, once on
# the newest dependencies PyPI has and once on pyproject's floors.
package-smoke: package
    for dist in dist/*.whl dist/*.tar.gz; do for mode in newest floors; do tools/package_smoke.sh "$dist" "$mode" || exit 1; done; done

# Regenerate the TypeScript contracts from the backend's Pydantic models.
contracts:
    uv run --project backend python tools/export_contracts.py

check-backend:
    # PyPI's license metadata may only name files inside backend/, so the
    # package carries its own copy of the root LICENSE. One text, two places.
    cmp LICENSE backend/LICENSE
    cd backend && uv sync --locked
    cd backend && uv run --locked ruff format --check .
    cd backend && uv run --locked ruff check .
    cd backend && uv run --locked ty check --error-on-warning
    cd backend && uv run --locked pytest -q

# Regenerate the contracts and fail on any byte difference. Generated files are
# never hand-edited, so a difference means a model changed and nobody told the
# browser.
check-contracts:
    uv run --locked --project backend python tools/export_contracts.py --check

# Lint, types, and the static export the package ships. The export is built to
# frontend/out and not copied, so the gate verifies the bundle without touching
# what `reposhape up` is serving.
check-frontend:
    pnpm install --frozen-lockfile
    cd frontend && pnpm exec eslint src
    cd frontend && pnpm exec tsc --noEmit
    cd frontend && REPOSHAPE_WEB_EXPORT=1 pnpm exec next build
    node tools/third_party_notices.mjs frontend/out/THIRD_PARTY_NOTICES.txt

check: check-backend check-contracts check-frontend

# Resolved for the host (arm64 Linux, the image's Python) and wheels only, so
# the image needs no compiler; hashed, so it can only install what was locked.
# Re-lock graphify for the release image after editing ops/graphify/requirements.in.
graphify-lock:
    uv pip compile ops/graphify/requirements.in \
      --python-version 3.14 --python-platform aarch64-manylinux_2_28 \
      --only-binary :all: --generate-hashes --quiet \
      -o ops/graphify/requirements.txt

# ---------------------------------------------------------------------------
# The hosted deployment (ADR-0008).
#
# Every recipe below runs FROM this machine and acts on the host over SSH.
# `ops/deployments/hosted.env` (gitignored; start from `hosted.env.example`)
# is the configuration they read, the SSH host included, so a deployment is
# reproducible from that file and this one alone. The host builds its own
# image, so its architecture need not match this machine's.
# ---------------------------------------------------------------------------

deploy_env := "ops/deployments/hosted.env"
deploy_host := `sed -n 's/^DEPLOY_SSH_HOST=//p' ops/deployments/hosted.env 2>/dev/null || true`
deploy_dir := "/opt/reposhape"

# Refuses before any SSH when there is nothing to deploy to.
_deploy-config:
    @test -f {{deploy_env}} || { echo "no {{deploy_env}}: copy {{deploy_env}}.example and fill it in" >&2; exit 1; }
    @test -n "{{deploy_host}}" || { echo "{{deploy_env}} sets no DEPLOY_SSH_HOST" >&2; exit 1; }

# Everything, in the only order that works. Each step is safe to re-run.
release: release-sync release-build release-deploy release-repos release-serve release-verify release-status

# Copy the working tree to the host, and record the commit and whether the tree
# was dirty, so the running image still says where it came from. The working
# tree rather than a fetch on the host, so a release is what is checked out
# here, pushed or not, and the gitignored hosted.env travels with it.
release-sync: _deploy-config
    ssh {{deploy_host}} 'sudo mkdir -p {{deploy_dir}} && sudo chown "$(id -u):$(id -g)" {{deploy_dir}}'
    rsync -az --delete \
      --exclude '.git/' \
      --exclude 'node_modules/' \
      --exclude '.venv/' \
      --exclude '__pycache__/' \
      --exclude '.next/' \
      --exclude 'frontend/out/' \
      --exclude 'backend/src/reposhape/web/' \
      --exclude '.source-commit' \
      --exclude '.source-dirty' \
      ./ {{deploy_host}}:{{deploy_dir}}/
    git rev-parse HEAD | ssh {{deploy_host}} 'cat > {{deploy_dir}}/.source-commit'
    git status --porcelain | ssh {{deploy_host}} 'cat > {{deploy_dir}}/.source-dirty'

# Build the image on the host, tagged with the release from hosted.env.
release-build: _deploy-config
    ssh {{deploy_host}} 'set -eu; cd {{deploy_dir}}; \
      set -a; . ops/deployments/hosted.env; set +a; \
      docker build \
        --build-arg SOURCE_COMMIT="$(cat .source-commit)" \
        --build-arg APPLICATION_RELEASE="$DEPLOY_RELEASE" \
        --build-arg BUILD_TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        -t reposhape:"$DEPLOY_RELEASE" .'

# Start the container and wait for it to report healthy.
release-deploy: _deploy-config
    ssh {{deploy_host}} 'set -eu; cd {{deploy_dir}}; \
      set -a; . ops/deployments/hosted.env; set +a; \
      docker compose -f compose.release.yaml up -d --wait --wait-timeout 120'

# Clone and analyse every curated repo inside the container. The only way a repo
# reaches a read-only server: the CLI is not gated, and using it needs a shell
# on the host. A repo already there is fetched and re-analysed, because asking
# for a URL is asking for that repository now.
release-repos: _deploy-config
    ssh {{deploy_host}} 'set -eu; cd {{deploy_dir}}; \
      set -a; . ops/deployments/hosted.env; set +a; \
      grep -Ev "^[[:space:]]*(#|$)" ops/deployments/curated-repos.txt | while read -r url; do \
        echo "== $url"; \
        docker compose -f compose.release.yaml exec -T web reposhape clone "$url" --quiet < /dev/null; \
      done'

# Not part of `release`: it only needs re-running when `release-repos` moved a
# repo. A one-off container per repo on the same image and volumes, rather than
# `exec` into the service: hermes-agent's graph (240k symbols, a 314 MB
# graph.json) peaks near 4 GB, and the service is capped at 1 GB for the reason
# compose.release.yaml gives. One repo at a time, because the host is in swap.
# graphify's LLM-free extraction and both projections for every curated repo.
release-graphify: _deploy-config
    ssh {{deploy_host}} 'set -eu; cd {{deploy_dir}}; \
      set -a; . ops/deployments/hosted.env; set +a; \
      grep -Ev "^[[:space:]]*(#|$)" ops/deployments/curated-repos.txt | while read -r url; do \
        echo "== $url"; \
        docker run --rm --memory 6g --memory-swap 6g --security-opt no-new-privileges:true \
          --env-file ops/deployments/hosted.env \
          -v reposhape-clones:/data/clones -v reposhape-cache:/data/cache \
          -v "$PWD/ops/link-rules:/etc/reposhape/links:ro" \
          reposhape:"$DEPLOY_RELEASE" reposhape graphify-extract "$url" < /dev/null; \
      done'

# Publish on the tailnet through Tailscale Serve. Serve, not Funnel: Funnel is
# the public internet, which is a separate decision from deploying (ADR-0008).
release-serve: _deploy-config
    ssh {{deploy_host}} 'set -eu; cd {{deploy_dir}}; \
      set -a; . ops/deployments/hosted.env; set +a; \
      sudo tailscale serve --bg --https "$DEPLOY_SERVE_PORT" "http://127.0.0.1:$DEPLOY_HOST_PORT"'

# The claims the deployed origin has to make, checked from outside it: it is
# read-only, it names no host paths, every operator route is absent, and the
# page and a graph still load.
release-verify: _deploy-config
    #!/usr/bin/env bash
    set -euo pipefail
    set -a; . ops/deployments/hosted.env; set +a
    o="$DEPLOY_ORIGIN"
    code() { curl -s --noproxy '*' -o /dev/null -w '%{http_code}' "$@"; }
    fail=0
    expect() { if [[ "$2" == *"$3"* ]]; then echo "ok    $1 ($2)"; else echo "FAIL  $1: got $2, want $3"; fail=1; fi; }
    expect "health is read-only" "$(curl -s --noproxy '*' "$o/api/health")" '"read_only":true,"cache_root":null'
    expect "page" "$(code "$o/")" 200
    expect "folders absent" "$(code "$o/api/folders?path=/")" 404
    expect "clone absent" "$(code -X POST -H 'content-type: application/json' -d '{"url":"https://x/y.git"}' "$o/api/clone")" 405
    expect "analyze absent" "$(code -X POST -H 'content-type: application/json' -d '{"repo_path":"/"}' "$o/api/analyze")" 405
    key=$(curl -s --noproxy '*' "$o/api/repos" | python3 -c 'import json,sys; rows=json.load(sys.stdin); print(rows[0]["key"] if rows else "")')
    if [[ -z "$key" ]]; then echo "FAIL  no repos served"; exit 1; fi
    expect "forget absent" "$(code -X DELETE "$o/api/repos/$key")" 405
    expect "graph of $key" "$(code "$o/api/graph/$key")" 200
    exit $fail

# What is running, and what it was built from.
release-status: _deploy-config
    ssh {{deploy_host}} 'set -eu; cd {{deploy_dir}}; \
      set -a; . ops/deployments/hosted.env; set +a; \
      echo "release   $DEPLOY_RELEASE"; \
      echo "commit    $(cat .source-commit)"; \
      if [ -s .source-dirty ]; then echo "tree      DIRTY at sync time"; else echo "tree      clean at sync time"; fi; \
      echo "origin    $DEPLOY_ORIGIN"; \
      echo; docker compose -f compose.release.yaml ps; \
      echo; docker compose -f compose.release.yaml exec -T web reposhape repos < /dev/null'

release-logs: _deploy-config
    ssh -t {{deploy_host}} 'cd {{deploy_dir}}; set -a; . ops/deployments/hosted.env; set +a; docker compose -f compose.release.yaml logs -f --tail 200'

# Stop the container. Keeps the image and both volumes, so `release-deploy`
# brings the same deployment back with its clones and analyses.
release-down: _deploy-config
    ssh {{deploy_host}} 'cd {{deploy_dir}}; set -a; . ops/deployments/hosted.env; set +a; docker compose -f compose.release.yaml down'
