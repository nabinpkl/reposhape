"""The one server: the browser client's page and the API it talks to.

The browser never runs a parser of its own. `POST /api/analyze` writes by
calling the same `analysis.analyze` the CLI calls, and every write sits on the
`operator` router, which a read-only server does not register (ADR-0008).

There is deliberately no SSE endpoint. A cold analysis of a 1,000-file repo
is measured in seconds, which a spinner covers, and every stream this app opens is
a stream that can silently fail to connect: in an earlier app a Vite proxy entry
downgraded an origin from HTTP/2 to HTTP/1.1, capped the browser at six
connections, and the last stream the page opened never connected, with no error
anywhere. If progress ever needs streaming, check the negotiated protocol first,
and check the protocol rather than the status code.
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from fastapi import APIRouter, FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.middleware.base import RequestResponseEndpoint

from reposhape import (
    browsing,
    cache,
    cloning,
    daemon,
    graphify,
    graphify_files,
    graphify_page,
    licensing,
    web_bundle,
)
from reposhape.analysis import analyze
from reposhape.browsing import NoSuchDirectoryError, UnreadableDirectoryError
from reposhape.cache import StaleArtifactError
from reposhape.cloning import CloneError, UnsupportedUrlError, UpdateOutcome
from reposhape.configuration import settings
from reposhape.graphify import GraphifyArtifactError
from reposhape.graphify_files import GraphifyFilesError
from reposhape.graphify_page import GraphifyPageError
from reposhape.graphing import build_view
from reposhape.models import (
    SOURCE_LABELS,
    Analysis,
    AnalysisSource,
    FileContents,
    FileNode,
    FolderListing,
    GraphifyPageStatus,
    GraphView,
    Health,
    RepoLicense,
    RepoPaths,
    RepoSummary,
    RuntimeLink,
    SourceOption,
)
from reposhape.scanning import language_of

# Two routers, and which one a route goes on is the whole public/personal
# split. `reads` answers from the cache and from files already in an analysed
# repo. `operator` acts on the host: it browses its folders, clones onto it,
# analyses or refreshes a path on it, deletes from its cache, or runs a program
# on it. A read-only server never registers `operator` at all (ADR-0008), and
# tests/test_api.py pins the read-only route set so a new route has to be put on
# one side on purpose.
reads = APIRouter()
operator = APIRouter()


class AnalyzeRequest(BaseModel):
    repo_path: str
    source: AnalysisSource = Field(
        default="imports",
        description="Which extractor's graph to build. `imports` is this tool's own; "
        "the graphify sources project that tool's symbol graph onto files so the two "
        "can be compared through the same clustering and the same renderer.",
    )
    refresh: bool = Field(
        default=False,
        description="Re-run even when a cached artifact exists for this repo.",
    )


class CloneRequest(BaseModel):
    url: str = Field(
        description="A git URL: https://, ssh://, git://, file://, or git@host:owner/repo."
    )


class CloneResponse(BaseModel):
    path: str = Field(description="Where the checkout is, on this machine. Durable.")
    already_present: bool = Field(
        description="True when a checkout was already there and was reused untouched."
    )


class UpdateReport(BaseModel):
    """What a refresh did to the checkout before re-analysing it.

    Null unless this tool cloned the repo itself. Everything else here belongs
    to the owner and is never fetched, so there is nothing to report.
    """

    outcome: UpdateOutcome
    detail: str | None = None
    sha: str | None = None


class AnalyzeResponse(BaseModel):
    key: str
    summary: RepoSummary
    stats_duration_ms: int
    from_cache: bool
    update: UpdateReport | None = None


def _require(key: str) -> Analysis:
    try:
        analysis = cache.find(key)
    except StaleArtifactError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    if analysis is None:
        raise HTTPException(status_code=404, detail=f"no cached analysis for key {key!r}")
    return analysis


def _summary_of(analysis: Analysis) -> RepoSummary:
    return RepoSummary(
        key=cache.repo_key(analysis.repo_path, analysis.source),
        source=analysis.source,
        repo_path=analysis.repo_path,
        repo_name=analysis.repo_name,
        git_sha=analysis.git_sha,
        dirty=analysis.dirty,
        generated_at=analysis.generated_at,
        files=len(analysis.files),
        edges=len(analysis.edges),
        exists=Path(analysis.repo_path).is_dir(),
    )


@reads.get("/api/health")
def health(request: Request) -> Health:
    """Also the only place the two roots are stated, and they are different roots.

    `cache_root` holds analyses, which `forget` deletes and which regenerate in
    seconds. `clone_root` holds checkouts, which nothing here deletes. The
    folder dialog shows the second one, because "where does a clone go" is the
    first question a git URL raises (ADR-0007). A read-only server states
    neither: they are paths on the host, and nothing a visitor can do uses them.
    """
    if request.app.state.read_only:
        return Health(status="ok", read_only=True)
    return Health(
        status="ok",
        read_only=False,
        cache_root=str(settings.cache_root),
        clone_root=str(cloning.clone_root()),
        pid=os.getpid(),
        build=request.app.state.build,
    )


@reads.get("/api/repos")
def list_repos() -> list[RepoSummary]:
    """Cached analyses, newest first. The repo picker's read path.

    One row per repo AND source, so the picker can show which extractors have
    been run against a repo and the source tabs can switch between them without
    re-analysing.
    """
    return cache.summaries()


@operator.delete("/api/repos/{key}")
def forget_repo(key: str) -> list[str]:
    """Take a repository out of the picker. Answers with every key removed.

    Removes the repository's artifacts for every source, not only the one
    named, because the picker shows a repo while any of them remain. Only the
    cache is touched; the analysed repo is never written to.
    """
    removed = cache.forget(key)
    if not removed:
        raise HTTPException(status_code=404, detail=f"no cached analysis for key {key!r}")
    return removed


@operator.get("/api/folders")
def list_folders(path: str = "") -> FolderListing:
    """Child directories of `path`, for picking a repo without typing its path.

    Directories only: no file name and no file content leaves here. A path that
    is half-typed is not an error, it is a prefix, so this lists the parent and
    filters -- but a path whose parent does not exist says so with a 404 rather
    than answering an empty list, because an empty list is what a working
    directory with nothing in it also looks like.
    """
    try:
        return browsing.listing(path)
    except NoSuchDirectoryError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except UnreadableDirectoryError as error:
        raise HTTPException(status_code=403, detail=str(error)) from error


@reads.get("/api/sources/{key}")
def list_sources(key: str, request: Request) -> list[SourceOption]:
    """Which extractors could produce a graph of this analysis's repo.

    `available` means an artifact is already cached and switching is a click;
    `ready` means it could be built on request. A graphify source that is
    neither says so with the reason, rather than offering a tab that fails.
    A read-only server builds nothing on request, so there only what is
    already cached is ready.
    """
    analysis = _require(key)
    repo = Path(analysis.repo_path)
    cached = {row.source: row.key for row in cache.summaries() if row.repo_path == str(repo)}
    if request.app.state.read_only:
        return [
            SourceOption(
                source=source,
                label=SOURCE_LABELS[source],
                key=cached.get(source),
                ready=source in cached,
                reason=None if source in cached else "not built on this server",
            )
            for source in ("imports", "graphify-imports", "graphify-all")
        ]
    graphify_ready = graphify.has_artifact(repo)
    return [
        SourceOption(
            source=source,
            label=SOURCE_LABELS[source],
            key=cached.get(source),
            ready=True if source == "imports" else graphify_ready,
            reason=None
            if source == "imports" or graphify_ready
            else f"no {graphify.ARTIFACT} in this repo",
        )
        for source in ("imports", "graphify-imports", "graphify-all")
    ]


@operator.post("/api/clone")
def clone_repo(request: CloneRequest) -> CloneResponse:
    """Put a remote repository on this machine, and answer with where it landed.

    Cloning and analysing are two calls rather than one. The clone is the slow,
    networked, once-per-repo half; the analysis is the same `POST /api/analyze`
    every other repo goes through, and keeping them apart is what stops a
    cloned repo being a special case anywhere downstream.

    A checkout that is already there is reused as it stands, never reset: it is
    an ordinary working tree, and this tool graphs repositories rather than
    managing them.
    """
    try:
        result = cloning.clone(request.url)
    except UnsupportedUrlError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except CloneError as error:
        # The URL was fine and git could not do it: no such repo, no
        # credentials, no network. That is upstream, not the caller's spelling.
        raise HTTPException(status_code=502, detail=str(error)) from error
    return CloneResponse(path=str(result.path), already_present=result.already_present)


@operator.post("/api/analyze")
def run_analysis(request: AnalyzeRequest) -> AnalyzeResponse:
    repo = Path(request.repo_path).expanduser()
    if not repo.is_dir():
        raise HTTPException(status_code=400, detail=f"not a directory: {repo}")

    # Refresh means "as it is now". For a checkout this tool cloned, now is
    # upstream: re-reading a working tree nothing can have touched is a button
    # that looks like it did something. Reported rather than silent, because a
    # fetch that was skipped or failed is exactly what explains an unchanged
    # graph, and it never blocks the analysis.
    moved = cloning.update(repo) if request.refresh else None
    update = (
        None
        if moved is None
        else UpdateReport(outcome=moved.outcome, detail=moved.detail, sha=moved.sha)
    )

    try:
        existing = None if request.refresh else cache.load(repo, request.source)
    except StaleArtifactError:
        existing = None  # a stale artifact is simply re-analysed here
    if existing is not None:
        return AnalyzeResponse(
            key=cache.repo_key(repo, request.source),
            summary=_summary_of(existing),
            stats_duration_ms=existing.stats.duration_ms,
            from_cache=True,
            update=update,
        )

    if request.source == "imports":
        result = analyze(repo)
    else:
        try:
            result = graphify.load(repo, request.source, scope=graphify.ensure_scope(repo))
        except GraphifyArtifactError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
    cache.write(result)
    return AnalyzeResponse(
        key=cache.repo_key(repo, request.source),
        summary=_summary_of(result),
        stats_duration_ms=result.stats.duration_ms,
        from_cache=False,
        update=update,
    )


@reads.get("/api/analysis/{key}")
def get_analysis(key: str) -> Analysis:
    """The whole artifact, exactly as the CLI wrote it."""
    return _require(key)


@reads.get("/api/paths/{key}")
def get_paths(key: str) -> RepoPaths:
    """The full path list, for the filter tree. Independent of any filter."""
    analysis = _require(key)
    return RepoPaths(
        paths=[node.path for node in analysis.files],
        test_paths=[node.path for node in analysis.files if node.is_test],
    )


@reads.get("/api/graph/{key}")
def get_graph(
    key: str,
    exclude: list[str] = Query(default=[]),  # noqa: B008 - FastAPI's parameter idiom
    include_tests: bool = False,
    include_type_only: bool = True,
    exclude_ext: list[str] = Query(default=[]),  # noqa: B008 - FastAPI's parameter idiom
) -> GraphView:
    """Filter first, then cluster. Excluding a path re-partitions the rest."""
    return _view(
        key,
        cache.version_of(key),
        frozenset(exclude),
        include_tests,
        include_type_only,
        frozenset(ext.lower().lstrip(".") for ext in exclude_ext if ext.strip(" .")),
    )


@lru_cache(maxsize=16)
def _view(
    key: str,
    version: int | None,
    excluded: frozenset[str],
    include_tests: bool,
    include_type_only: bool,
    excluded_extensions: frozenset[str],
) -> GraphView:
    """One partition per artifact version and filter set, computed once.

    Every request here used to read the artifact and re-run Louvain, which is
    the dearest thing this server does and the first thing a public page gets
    asked for over and over. `version` is the artifact's mtime, so a
    re-analysis misses the memo instead of serving the old partition, and a
    missing artifact raises through `_require` -- which `lru_cache` never
    stores. Bounded by entry count, and the count is set by memory, not hits:
    one hermes-agent view (4,131 nodes, 17,258 edges) holds about 15 MB, so the
    128 this started with could hold about 2 GB, and on the 1 GB deployment a
    reader unchecking 74 paths pinned the container at its limit and stalled
    every request. 16 is about 240 MB at worst on the largest curated repo.
    """
    return build_view(
        _require(key),
        excluded=excluded,
        include_tests=include_tests,
        include_type_only=include_type_only,
        excluded_extensions=excluded_extensions,
    )


@reads.get("/api/graphify-status/{key}")
def graphify_status(key: str, request: Request) -> GraphifyPageStatus:
    """Can graphify's own page be shown for this repo, and if not, what builds it."""
    return _page_status(_require(key), request)


def _page_status(analysis: Analysis, request: Request) -> GraphifyPageStatus:
    ready, reason = graphify_page.status_of(Path(analysis.repo_path))
    if not ready and request.app.state.read_only:
        # The operator's remedy names a host path and a command visitors
        # cannot run, so a read-only server says only that it is absent.
        reason = "graphify did not write its own page for this repo on this server."
    return GraphifyPageStatus(ready=ready, reason=reason)


@reads.get("/api/graphify-files-status/{key}")
def graphify_files_status(key: str, request: Request) -> GraphifyPageStatus:
    """Can the file-level graphify rendering be shown for this analysis.

    The page builds on demand from the cached analysis, so readiness is only
    whether graphify's renderer is installed at all.
    """
    _require(key)
    if request.app.state.read_only:
        # Building the page runs graphify and writes beside the cache, so the
        # route that does it is an operator route and is not registered here.
        return GraphifyPageStatus(
            ready=False, reason="graphify's renderer is not offered on this server."
        )
    if graphify_page.binary() is None:
        return GraphifyPageStatus(
            ready=False,
            reason="the `graphify` binary is not on PATH, so its renderer cannot run here.",
        )
    return GraphifyPageStatus(ready=True, reason=None)


@operator.get("/api/graphify-files/{key}")
def graphify_files_html(
    key: str,
    exclude: list[str] = Query(default=[]),  # noqa: B008 - FastAPI's parameter idiom
    include_tests: bool = False,
    include_type_only: bool = True,
    exclude_ext: list[str] = Query(default=[]),  # noqa: B008 - FastAPI's parameter idiom
) -> Response:
    """This analysis drawn by graphify's own exporter: files only, no symbols.

    Built on demand through `graphify export html` over a synthesized
    file-level graph, and rebuilt whenever the analysis artifact is newer
    than the page. Same renderer as graphify's own page, same partition and
    labels as our tabs. The shape parameters are the same four `/api/graph`
    takes, and the keep set comes from the same `build_view`, so this pane
    and ours always agree about what a filter means; only the membership of
    the exported page is filtered, never re-exported.
    """
    analysis = _require(key)
    try:
        html = graphify_files.filtered_html(
            key,
            analysis,
            excluded=frozenset(exclude),
            include_tests=include_tests,
            include_type_only=include_type_only,
            excluded_extensions=frozenset(
                ext.lower().lstrip(".") for ext in exclude_ext if ext.strip(" .")
            ),
        )
    except (GraphifyFilesError, GraphifyPageError) as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    return Response(content=html, media_type="text/html")


@reads.get("/api/graphify-page/{key}")
def graphify_page_html(key: str, request: Request) -> FileResponse:
    """graphify's `graph.html`, byte for byte as its own pipeline wrote it.

    Served, never re-rendered: importing its data into our renderer would make
    this a fourth extractor tab, not the rendering comparison it is.
    """
    analysis = _require(key)
    page = graphify_page.page_path(Path(analysis.repo_path))
    if not page.is_file():
        reason = _page_status(analysis, request).reason
        raise HTTPException(status_code=404, detail=reason or "no graphify page here")
    return FileResponse(page, media_type="text/html")


@reads.get("/api/file/{key}")
def get_file(key: str, path: str) -> FileContents:
    """File contents, read from disk now rather than embedded at analysis time.

    `path` must name a file the analysis already knows about. That membership
    check is the path-traversal guard: nothing outside the analysed repo is
    reachable, and `../` never appears in an analysed path.
    """
    analysis = _require(key)
    known: dict[str, FileNode] = {node.path: node for node in analysis.files}
    node = known.get(path)
    if node is None:
        raise HTTPException(status_code=404, detail=f"{path!r} is not in this analysis")

    absolute = Path(analysis.repo_path) / path
    try:
        raw = absolute.read_bytes()
    except OSError as error:
        raise HTTPException(status_code=410, detail=f"unreadable on disk: {error}") from error

    truncated = len(raw) > settings.max_file_view_bytes
    text = raw[: settings.max_file_view_bytes].decode("utf-8", errors="replace")
    return FileContents(
        path=path,
        language=language_of(path),
        lines=raw.count(b"\n") + 1 if raw else 0,
        bytes=len(raw),
        truncated=truncated,
        text=text,
    )


@reads.get("/api/links/{key}")
def get_links(key: str, path: str, include_tests: bool = False) -> list[RuntimeLink]:
    """Runtime links with `path` at either end, whatever the path filter.

    The file pane's "reached without an import" list. Read from the artifact
    rather than the view, because the other end is often a file the path
    filter hides, and that is exactly the connection the graph could not
    show. Tests follow the reader's own setting: a hook fired by twelve test
    files buries the one production caller the reader came for.
    """
    analysis = _require(key)
    tests = {node.path for node in analysis.files if node.is_test}
    if path not in {node.path for node in analysis.files}:
        raise HTTPException(status_code=404, detail=f"{path!r} is not in this analysis")
    return [
        link
        for link in analysis.links
        if path in (link.source, link.target)
        and (include_tests or (link.source not in tests and link.target not in tests))
    ]


@reads.get("/api/license/{key}")
def get_license(key: str, path: str | None = None) -> RepoLicense:
    """The license governing `path`, read from disk now, like `/api/file`.

    The nearest license above the file, which in a monorepo is often a
    package's own rather than the root's. Without `path`, the root's. A read
    route on purpose: the hosted page shows other people's code, and the notice
    that permits it has to be reachable from wherever that code is.
    """
    analysis = _require(key)
    if path is not None and path not in {node.path for node in analysis.files}:
        raise HTTPException(status_code=404, detail=f"{path!r} is not in this analysis")
    return licensing.find(Path(analysis.repo_path), path)


# graphify's pages are framed by this app on the same origin, so they opt out of
# the blanket DENY. SAMEORIGIN still refuses any other site.
_FRAMED = ("/api/graphify-page/", "/api/graphify-files/")


def create_app(*, read_only: bool) -> FastAPI:
    """The app, with or without the routes that act on the host.

    Built by a factory rather than at import time with a branch inside each
    route, so read-only is a property of which routes exist, and the tests can
    build both apps in one process.
    """
    app = FastAPI(title="reposhape", version="0.1.0")
    app.state.read_only = read_only
    # Taken once, at start: the build this process is running, which is what
    # `reposhape up` compares with its own to tell a stale server (daemon.py).
    app.state.build = daemon.build_id()

    @app.middleware("http")
    async def same_site_only(request: Request, call_next: RequestResponseEndpoint) -> Response:
        # Loopback is not a boundary a browser respects. Any page the owner has
        # open can send this server a request, and a page whose name an
        # attacker re-points at 127.0.0.1 (DNS rebinding) can read the answers
        # too, folder listings included. Two checks close both:
        #
        # * The Host must be a name this server is reached by. A rebound page
        #   still sends its own name, so it is refused here before any route.
        # * An /api request another site's page made is refused. The browser
        #   states that in Sec-Fetch-Site and a page cannot forge it. Another
        #   port on the same name counts as another site: localhost:3000 is not
        #   this page. Navigations are left alone, so a link to the page from
        #   anywhere still opens it.
        #
        # Settings are read per request rather than at build time so the tests,
        # and an operator's env, change them without rebuilding the app.
        if request.url.hostname not in settings.allowed_hosts:
            return Response(f"host not allowed: {request.url.hostname}", status_code=400)
        fetched_by = request.headers.get("sec-fetch-site")
        if request.url.path.startswith("/api/") and fetched_by in ("cross-site", "same-site"):
            return Response(f"refused a {fetched_by} request", status_code=403)
        return await call_next(request)

    @app.middleware("http")
    async def security_headers(request: Request, call_next: RequestResponseEndpoint) -> Response:
        # Every response, page and API alike: no sniffing, no referrer leakage,
        # no framing by another site. These lived in the Next proxy while Next
        # served the page; one server now answers both, so they live here.
        response = await call_next(request)
        response.headers["x-content-type-options"] = "nosniff"
        response.headers["referrer-policy"] = "no-referrer"
        framed = request.url.path.startswith(_FRAMED)
        response.headers["x-frame-options"] = "SAMEORIGIN" if framed else "DENY"
        return response

    app.include_router(reads)
    if not read_only:
        app.include_router(operator)

    # Last, so every /api route is matched before the page's files are. Absent
    # in a checkout that never ran `just web-export`, which is the frontend
    # developer's case (`just web` serves the page with hot reload and proxies
    # here); `reposhape up` refuses to start without it, so that absence is never how
    # a reader meets the tool.
    if web_bundle.present():
        app.mount("/", StaticFiles(directory=web_bundle.BUNDLE_DIR, html=True), name="web")
    return app


app = create_app(read_only=settings.read_only)
