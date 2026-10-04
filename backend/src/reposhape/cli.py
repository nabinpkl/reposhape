"""`reposhape up` is the whole tool in one command. The rest are its pieces.

`reposhape analyze-repo` emits the JSON, `reposhape serve` reads it and serves the browser
client over it, and `reposhape up` analyses a repo when given one, makes sure the
background server is running, and opens the page. `reposhape status` and `reposhape down`
are that server's other two verbs. Progress goes to stderr so
`reposhape analyze-repo <repo> --out -` stays a clean pipe into jq.
"""

from __future__ import annotations

import importlib.metadata
import json
import sys
import webbrowser
from pathlib import Path
from typing import Annotated

import typer

from reposhape import cache, cloning, daemon, graphify_page, launching, web_bundle
from reposhape.analysis import analyze
from reposhape.cache import StaleArtifactError
from reposhape.cloning import CloneError
from reposhape.configuration import settings
from reposhape.graphify_page import GraphifyPageError
from reposhape.graphing import build_view
from reposhape.launching import LaunchError
from reposhape.models import Analysis

app = typer.Typer(
    add_completion=False,
    help="See the shape of a repository at a glance: its file-level import graph.",
    no_args_is_help=True,
)


def _print_version(value: bool) -> None:
    if value:
        print(f"reposhape {importlib.metadata.version('reposhape')}")
        raise typer.Exit()


@app.callback()
def _every_command(
    version: Annotated[
        bool,
        typer.Option(
            "--version", callback=_print_version, is_eager=True, help="Print the version and exit."
        ),
    ] = False,
) -> None:
    # The background server is a POSIX session leader stopped by signals
    # (daemon.py). Said here, once, rather than as an AttributeError on
    # signal.SIGKILL the first time someone runs `reposhape down` on Windows.
    if sys.platform == "win32":
        _stderr("reposhape runs on macOS and Linux; Windows is not supported.")
        raise typer.Exit(1)


def _stderr(message: str) -> None:
    print(message, file=sys.stderr)


def _progress_reporter() -> object:
    state = {"stage": "", "last": -1}

    def report(stage: str, done: int, total: int) -> None:
        if stage != state["stage"]:
            state["stage"] = stage
            state["last"] = -1
        percent = int(done / total * 100) if total else 0
        if percent == state["last"] and stage != "done":
            return
        state["last"] = percent
        suffix = f" {done}/{total}" if total else ""
        print(f"\r{stage}{suffix}".ljust(48), end="", file=sys.stderr, flush=True)
        if stage == "done":
            print(file=sys.stderr)

    return report


def _build(repo: Path, *, quiet: bool) -> Analysis:
    progress = (lambda *_: None) if quiet else _progress_reporter()
    return analyze(repo, progress=progress)  # ty: ignore[invalid-argument-type]


def _update_line(result: cloning.UpdateResult) -> str:
    match result.outcome:
        case "updated":
            return f"fetched: now at {(result.sha or '')[:8]}"
        case "current":
            return "fetched: already the latest commit"
        case _:
            return f"not fetched: {result.detail}"


def _ensure_analysis(repo: Path, *, refresh: bool, quiet: bool) -> Analysis:
    """The cached analysis for `repo`, running one if there is not a usable one.

    A stale artifact is re-analysed rather than reported: artifacts are a cache,
    and the owner asked for a graph, not for a schema lecture. `reposhape analyze-repo`
    is where a stale artifact still says so, because there the artifact is the
    product.
    """
    # A refresh of a checkout this tool cloned fetches it first: asking for a
    # repo as it is now means upstream, not what was downloaded once. Nothing
    # else is ever fetched, and a fetch that fails is reported and then ignored,
    # because being offline is a reason to graph what is on disk, not to refuse.
    if refresh:
        moved = cloning.update(repo)
        if moved is not None:
            _stderr(_update_line(moved))

    try:
        existing = None if refresh else cache.load(repo)
    except StaleArtifactError as error:
        _stderr(f"{error}")
        existing = None

    if existing is not None:
        age = existing.generated_at.strftime("%Y-%m-%d %H:%M")
        _stderr(
            f"cached analysis from {age}: {len(existing.files)} files, "
            f"{len(existing.edges)} edges  (--refresh to re-run)"
        )
        return existing

    result = _build(repo, quiet=quiet)
    cache.write(result)
    stats = result.stats
    _stderr(
        f"{len(result.files)} files, {stats.edges} edges, "
        f"{stats.unresolved} unresolved, {stats.duration_ms}ms"
    )
    return result


def _resolve_target(repo: str) -> Path:
    """A path stays a path; a git URL becomes the checkout it names.

    One place decides which of the two a string is, so `reposhape up` and `reposhape clone`
    cannot disagree about what counts as a URL.
    """
    if cloning.looks_remote(repo):
        result = cloning.clone(repo)
        _stderr(f"{'reusing clone at' if result.already_present else 'cloned into'} {result.path}")
        return result.path
    return launching.repo_root_of(Path(repo))


@app.command()
def clone(
    url: Annotated[str, typer.Argument(help="Git URL: https://, ssh://, git://, or git@host:x/y.")],
    quiet: Annotated[bool, typer.Option("--quiet", "-q", help="No progress output.")] = False,
) -> None:
    """Clone a repository into the durable clone root, and analyse it.

    The checkout is kept, not borrowed: it lands under `REPOSHAPE_CLONE_ROOT`
    (`~/.local/share/reposhape/clones` by default) as `<host>/<owner>/<name>`
    and nothing in this tool ever deletes it, `reposhape forget` included. See
    ADR-0007. An existing checkout is reused as it stands and never reset.
    """
    try:
        result = cloning.clone(url)
    except CloneError as error:
        _stderr(f"error: {error}")
        raise typer.Exit(code=1) from error

    verb = "already cloned" if result.already_present else "cloned"
    _stderr(f"{verb}: {result.path}")
    try:
        # A checkout that was already here is refreshed, because asking for a
        # URL is asking for that repository now. A fresh one has nothing to
        # fetch and nothing cached.
        _ensure_analysis(result.path, refresh=result.already_present, quiet=quiet)
    except (NotADirectoryError, OSError) as error:
        _stderr(f"error: {error}")
        raise typer.Exit(code=1) from error
    print(result.path)
    _stderr(f"graph it with: reposhape up {result.path}")


@app.command()
def up(
    repo: Annotated[
        str | None,
        typer.Argument(
            help="A repository to graph: a path (`.` for here), or a git URL to clone. "
            "Without one, opens the repo picker."
        ),
    ] = None,
    refresh: Annotated[
        bool, typer.Option("--refresh", help="Re-analyse even if a cached artifact exists.")
    ] = False,
    port: Annotated[
        int | None, typer.Option("--port", help="Port for the page and its API.")
    ] = None,
    open_browser: Annotated[
        bool, typer.Option("--open/--no-open", help="Open the URL in a browser.")
    ] = True,
    quiet: Annotated[bool, typer.Option("--quiet", "-q", help="No progress output.")] = False,
) -> None:
    """Make sure the server is running, open the page, and return.

    The server runs in the background and outlives this terminal (ADR-0010);
    `reposhape down` stops it. With a repo, it is analysed here first, with progress
    on this terminal, and the page opens on its graph. Without one, the page
    opens on the picker, where a folder or a git URL can be added.

    A git URL is cloned into the durable clone root. Typed as text rather than
    as a `Path` because `Path("https://host/x")` silently collapses the `//`.
    """
    if not web_bundle.present():
        _stderr(
            f"error: no browser client at {web_bundle.BUNDLE_DIR}. "
            "In a checkout, run `just web-export` once to build it."
        )
        raise typer.Exit(code=1)
    stale = web_bundle.staleness()
    if stale is not None:
        _stderr(f"warning: {stale}")

    analysis: Analysis | None = None
    root: Path | None = None
    if repo is not None:
        try:
            root = _resolve_target(repo)
        except CloneError as error:
            _stderr(f"error: {error}")
            raise typer.Exit(code=1) from error
        if not root.is_dir():
            _stderr(f"error: not a directory: {repo}")
            raise typer.Exit(code=1)
        try:
            analysis = _ensure_analysis(root, refresh=refresh, quiet=quiet)
        except (NotADirectoryError, OSError) as error:
            _stderr(f"error: {error}")
            raise typer.Exit(code=1) from error

    try:
        origin = daemon.ensure(settings.host, port or settings.port)
    except LaunchError as error:
        _stderr(f"error: {error}")
        raise typer.Exit(code=1) from error

    if root is not None and analysis is not None:
        url = launching.graph_url(origin, cache.repo_key(root))
        print(
            f"\n  repo  {root}  ({len(analysis.files):,} files, {len(analysis.edges):,} edges)\n"
            f"  open  {url}\n"
        )
    else:
        url = launching.picker_url(origin)
        print(f"\n  open  {url}\n")
    if open_browser:
        webbrowser.open(url)


@app.command()
def status() -> None:
    """Whether the background server is running, and where."""
    running = daemon.status()
    if running is None:
        print("stopped")
        return
    since = running.started_at.astimezone()
    print(f"running  {running.url}  (pid {running.pid}, since {since:%Y-%m-%d %H:%M})")


@app.command()
def down() -> None:
    """Stop the background server `reposhape up` started."""
    try:
        stopped = daemon.stop()
    except LaunchError as error:
        _stderr(f"error: {error}")
        raise typer.Exit(code=1) from error
    if stopped is None:
        print("no server was running")
        return
    print(f"stopped  {stopped.url}  (pid {stopped.pid})")


@app.command()
def analyze_repo(
    repo: Annotated[Path, typer.Argument(help="Repository to analyse.")],
    out: Annotated[
        str | None,
        typer.Option("--out", "-o", help="Write here instead of the cache. '-' for stdout."),
    ] = None,
    quiet: Annotated[bool, typer.Option("--quiet", "-q", help="No progress output.")] = False,
) -> None:
    """Scan a repo and write its import graph as JSON."""
    if cloning.looks_remote(str(repo)):
        # Said here rather than left to fail as "not a directory", because the
        # answer is a different command rather than a different path.
        _stderr(f"error: {repo} is a URL. Run: reposhape clone {repo}")
        raise typer.Exit(code=1)
    try:
        result = _build(repo, quiet=quiet)
    except (NotADirectoryError, OSError) as error:
        _stderr(f"error: {error}")
        raise typer.Exit(code=1) from error

    if out == "-":
        json.dump(result.model_dump(mode="json"), sys.stdout, indent=2)
        sys.stdout.write("\n")
    elif out:
        cache.write_json_to(result, Path(out))
        _stderr(f"wrote {out}")
    else:
        written = cache.write(result)
        _stderr(f"wrote {written}")

    stats = result.stats
    _stderr(
        f"{len(result.files)} files, {stats.edges} edges, "
        f"{stats.unresolved} unresolved, {len(result.external)} external packages, "
        f"{stats.duration_ms}ms"
    )


@app.command()
def view(
    repo: Annotated[Path, typer.Argument(help="Repository to summarise.")],
    include_tests: Annotated[bool, typer.Option("--include-tests")] = False,
    top: Annotated[int, typer.Option("--top", help="How many clusters to list.")] = 20,
) -> None:
    """Print the clustered view for a cached analysis, without a browser."""
    try:
        analysis = cache.load(repo)
    except StaleArtifactError as error:
        _stderr(f"{error}")
        raise typer.Exit(code=1) from error
    if analysis is None:
        _stderr(f"no cached analysis for {repo}. Run: reposhape analyze-repo {repo}")
        raise typer.Exit(code=1)

    result = build_view(analysis, include_tests=include_tests)
    stats = result.stats
    print(
        f"{stats.visible_files}/{stats.total_files} files, "
        f"{stats.visible_edges}/{stats.total_edges} edges, {stats.clusters} clusters"
    )
    for cluster in result.clusters[:top]:
        print(f"  {cluster.size:>5}  {cluster.label}")


@app.command("graphify-page")
def graphify_page_cmd(
    repo: Annotated[
        str,
        typer.Argument(
            help="Repository to build the symbol graph for: a path, or the git URL it was "
            "cloned from."
        ),
    ] = ".",
    refresh: Annotated[
        bool, typer.Option("--refresh", help="Re-run graphify's extraction, then the page.")
    ] = False,
) -> None:
    """Build the symbol graph for a repo, with graphify's own pipeline.

    Symbols are graphify's data, so this drives the `graphify` binary: its
    LLM-free `graphify update` from scratch, `graphify export html` when only
    the page is missing. The browser's `symbol graph` tab serves the result
    byte for byte. A read-only server builds nothing on request, so this is
    also how its tab gets a page. A URL names the checkout `reposhape clone`
    made of it and never clones.
    """
    if cloning.looks_remote(repo):
        try:
            root = cloning.destination(cloning.parse(repo))
        except CloneError as error:
            _stderr(f"error: {error}")
            raise typer.Exit(code=1) from error
        if not root.is_dir():
            _stderr(f"error: {repo} is not cloned here. Run: reposhape clone {repo}")
            raise typer.Exit(code=1)
    else:
        root = launching.repo_root_of(Path(repo))
    if not root.is_dir():
        _stderr(f"error: not a directory: {repo}")
        raise typer.Exit(code=1)
    try:
        page = graphify_page.ensure(root, refresh=refresh)
    except GraphifyPageError as error:
        _stderr(f"error: {error}")
        raise typer.Exit(code=1) from error
    _stderr(f"wrote {page}")


@app.command()
def repos() -> None:
    """List cached analyses. This is the server's repo picker, on the terminal."""
    rows = cache.summaries()
    if not rows:
        print(f"no cached analyses under {settings.cache_root}")
        return
    for row in rows:
        marker = "" if row.exists else "  (path is gone)"
        sha = (row.git_sha or "no-git")[:8]
        dirty = "+" if row.dirty else " "
        print(
            f"{row.generated_at:%Y-%m-%d %H:%M}  {sha}{dirty}  "
            f"{row.files:>5} files  {row.repo_path}{marker}"
        )


@app.command()
def forget(
    repo: Annotated[
        Path, typer.Argument(help="Repository to forget, as `reposhape repos` prints it.")
    ],
) -> None:
    """Take a repository's analysis out of the cache.

    The same removal as the browser's Forget. The path is not resolved through
    git and need not exist, because a repository that has been deleted or moved
    is the one whose rows are left behind. The repository itself is never
    touched.
    """
    key = cache.key_for(repo)
    if key is None:
        _stderr(f"no cached analysis for {repo}. `reposhape repos` lists what is cached.")
        raise typer.Exit(code=1)
    for removed in cache.forget(key):
        print(f"forgot {removed}")


@app.command()
def serve(
    host: Annotated[str | None, typer.Option("--host")] = None,
    port: Annotated[int | None, typer.Option("--port")] = None,
    reload: Annotated[bool, typer.Option("--reload")] = False,
    register: Annotated[
        bool,
        typer.Option(
            "--register",
            help="Run as the background server `reposhape up` starts and finds again.",
        ),
    ] = False,
) -> None:
    """Run the server in the foreground: the API, and the browser client when built in."""
    import uvicorn

    if register:
        if reload:
            _stderr("error: --register and --reload do not combine")
            raise typer.Exit(code=2)
        daemon.serve_registered(host or settings.host, port or settings.port)
        return
    uvicorn.run(
        "reposhape.api:app",
        host=host or settings.host,
        port=port or settings.port,
        reload=reload,
    )


if __name__ == "__main__":
    app()
