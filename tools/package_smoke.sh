#!/usr/bin/env bash
# Install a built distribution the way a user would and drive it.
#
#   tools/package_smoke.sh <wheel or sdist> [newest|floors]
#
# A fresh virtualenv, outside the checkout, resolving dependencies from PyPI
# rather than from uv.lock: that is what `uv tool install reposhape` gets.
# `floors` pins every direct dependency to the lowest version pyproject.toml
# allows, which proves those floors rather than trusting them. (uv's own
# `lowest-direct` does not: the distribution is the direct requirement there,
# and its dependencies still resolve to the newest.) Every path the tool writes is redirected into a temporary directory, so
# this neither reads nor disturbs the machine's own reposhape state or server.
#
# Checks: `--version` names the distribution's version; `reposhape up <repo>`
# starts the background server; health answers with that build; `/` is the
# page, not merely a 200; the notices file is served; the graph holds the
# fixture's two edges; `reposhape down` stops the server.
set -euo pipefail

dist="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
mode="${2:-newest}"
python="${SMOKE_PYTHON:-3.14}"

name="$(basename "$dist")"
version="${name#reposhape-}"
version="${version%%-py3-*}"
version="${version%.tar.gz}"

work="$(mktemp -d)"
venv="$work/venv"
export REPOSHAPE_STATE_ROOT="$work/state"
export REPOSHAPE_CACHE_ROOT="$work/cache"
export REPOSHAPE_CLONE_ROOT="$work/clones"
export REPOSHAPE_LINK_RULES_DIR="$work/links"
export REPOSHAPE_PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
origin="http://127.0.0.1:$REPOSHAPE_PORT"

cleanup() {
  if [[ -x "$venv/bin/reposhape" ]]; then "$venv/bin/reposhape" down >/dev/null 2>&1 || true; fi
  rm -rf "$work"
}
trap cleanup EXIT

fail() { echo "FAIL  $*" >&2; exit 1; }
ok() { echo "ok    $*"; }
get() { curl -s --noproxy '*' --max-time 10 "$@"; }

echo "== $name, $mode dependencies, Python $python"
uv venv --quiet --python "$python" "$venv"
pins=()
if [[ "$mode" == "floors" ]]; then
  # The distribution's own Requires-Dist, `name>=floor` becoming `name==floor`.
  python3 - "$dist" > "$work/floors.txt" <<'PY'
import re, sys, tarfile, zipfile
dist = sys.argv[1]
if dist.endswith(".whl"):
    with zipfile.ZipFile(dist) as wheel:
        (name,) = [n for n in wheel.namelist() if n.endswith(".dist-info/METADATA")]
        metadata = wheel.read(name).decode()
else:
    with tarfile.open(dist) as sdist:
        (member,) = [m for m in sdist.getmembers() if m.name.count("/") == 1 and m.name.endswith("/PKG-INFO")]
        metadata = sdist.extractfile(member).read().decode()
for line in metadata.splitlines():
    found = re.match(r"Requires-Dist: ([A-Za-z0-9_.-]+).*>=([0-9][^,; ]*)", line)
    if found:
        print(f"{found[1]}=={found[2]}")
PY
  pins=(--constraint "$work/floors.txt")
elif [[ "$mode" != "newest" ]]; then
  fail "mode is newest or floors, not $mode"
fi
uv pip install --quiet --python "$venv/bin/python" "${pins[@]}" "$dist"
uv pip list --python "$venv/bin/python" 2>/dev/null \
  | grep -Ei '^(fastapi|uvicorn|pydantic|pydantic-settings|typer|networkx|pathspec|tree-sitter[a-z-]*) ' \
  | sed 's/^/      /'

cd "$work"

got="$("$venv/bin/reposhape" --version)"
[[ "$got" == "reposhape $version" ]] || fail "--version said '$got', want 'reposhape $version'"
ok "--version: $got"

repo="$work/fixture"
mkdir -p "$repo/app" "$repo/pkg"
printf 'import { helper } from "./util";\nconsole.log(helper);\n' > "$repo/app/main.ts"
printf 'export const helper = 1;\n' > "$repo/app/util.ts"
: > "$repo/pkg/__init__.py"
printf 'from pkg.b import VALUE\n\nprint(VALUE)\n' > "$repo/pkg/a.py"
printf 'VALUE = 1\n' > "$repo/pkg/b.py"
git -C "$repo" init --quiet
git -C "$repo" add -A

out="$("$venv/bin/reposhape" up "$repo" --no-open --quiet)"
url="$(printf '%s\n' "$out" | sed -n 's/^ *open  *//p')"
key="${url##*repo=}"
[[ -n "$key" && "$url" == "$origin/"* ]] || fail "up printed no graph URL on $origin: $out"
ok "up: $url"

health="$(get "$origin/api/health")"
python3 - "$health" "$version" <<'EOF' || fail "health: $health"
import json, sys
health = json.loads(sys.argv[1])
assert health["read_only"] is False, health
assert health["build"].startswith(sys.argv[2] + "+"), health
EOF
ok "health: build $(printf '%s' "$health" | python3 -c 'import json,sys; print(json.load(sys.stdin)["build"])')"

# Read whole, then matched: piping curl into `grep -q` or `head` closes the pipe
# early, curl exits 23, and pipefail reports a failure that is not one.
page="$(get "$origin/")"
[[ "$page" == *'<title>reposhape</title>'* ]] || fail "/ is not the page"
ok "page: / carries the app's title"

notices="$(get "$origin/THIRD_PARTY_NOTICES.txt")"
[[ "$notices" == "Third-party software"* ]] || fail "the notices file is not served"
ok "notices: served beside the page"

graph="$(get "$origin/api/graph/$key")"
python3 - "$graph" <<'EOF' || fail "graph: $graph"
import json, sys
edges = {(edge["source"], edge["target"]) for edge in json.loads(sys.argv[1])["edges"]}
want = {("app/main.ts", "app/util.ts"), ("pkg/a.py", "pkg/b.py")}
assert want <= edges, edges
EOF
ok "graph: the TypeScript and Python edges are both there"

"$venv/bin/reposhape" down >/dev/null
if get -o /dev/null "$origin/api/health"; then fail "the server still answers after down"; fi
ok "down: the server is gone"
