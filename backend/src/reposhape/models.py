"""The wire contract, and the on-disk JSON schema. Same models for both.

`Analysis` is exactly what `reposhape analyze` writes to a file and what the
server reads back. There is no second representation to drift from it.

Clusters are deliberately NOT part of `Analysis`. They are computed per request
in `graphing.cluster`, after the caller's filters have been applied, because a
partition computed over files you have since excluded describes a graph you are
no longer looking at (ADR-0002).
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

# Bumped when the artifact's shape changes. There is no migration path by
# design: artifacts are cheap to regenerate and a migration is a second
# reader of a format nobody has yet had to live with.
SCHEMA_VERSION = 5

Language = Literal["typescript", "javascript", "vue", "python"]

ImportKind = Literal["static", "export_from", "dynamic", "require", "from_import"]

# Every way a specifier can fail to become an edge.
ResolutionOutcome = Literal[
    "external_package",
    "asset",
    "no_matching_file",
    "outside_repo",
    "unparsed_alias",
]

# The subset that means something is wrong. `external_package` and `asset` are
# ordinary facts about a codebase, so they are counted rather than reported: an
# error list that fills with `react` and `./styles.css` trains you to ignore it,
# and then it cannot tell you when an alias genuinely stops resolving.
UnresolvedReason = Literal["no_matching_file", "outside_repo", "unparsed_alias"]


class FileNode(BaseModel):
    """One repo-local source file. `path` is repo-relative, POSIX separators."""

    path: str
    language: Language
    is_test: bool
    lines: int
    bytes: int


class ImportEdge(BaseModel):
    """A directed file-to-file import, collapsed from one or more statements."""

    source: str
    target: str
    weight: int = Field(description="How many import statements produced this edge.")
    type_only: bool = Field(
        description="True when every contributing statement was a type-only import. "
        "Such an edge disappears at runtime, so a consumer may want to drop it."
    )


class UnresolvedImport(BaseModel):
    """A specifier that produced no edge, and why.

    Recorded rather than dropped. A specifier that silently vanishes is
    indistinguishable from a parser that silently broke, and that is the
    absence that costs an evening.
    """

    source: str
    specifier: str
    reason: UnresolvedReason
    line: int


LinkKind = Literal["event", "process", "loader"]


class RuntimeLink(BaseModel):
    """Two files coupled at runtime with no import between them (ADR-0009).

    Found by syntax, like an import: a name written literally at both ends
    (`event`), a module started as a program (`process`), or a rule an
    operator wrote for a loader that globs a directory (`loader`). Never
    clustered on: these are drawn over the import graph, not fed into it.
    """

    kind: LinkKind
    key: str = Field(
        description="The event name, the module started, or the loader rule's glob. "
        "What the two ends have in common, and what to search for to see it."
    )
    source: str
    source_line: int
    target: str
    target_line: int


class LinkStats(BaseModel):
    """What the runtime-link pass could and could not see, as counts.

    The same rule as unresolved imports: a name that could not be read is
    counted, never silently dropped.
    """

    links: int
    keys_paired: int
    keys_unpaired: int = Field(
        description="Names sent and never received here, or the reverse. Usually the other "
        "end is outside the repo (a plugin, a client)."
    )
    dynamic_names: int = Field(
        description="Event calls whose name is not a literal (`emit(name)`), so no link can "
        "be read from them."
    )
    generic_names: int = Field(
        description="One-word lowercase names (`error`, `data`, `close`): library stream "
        "events, dropped because pairing them links every stream user to every other."
    )
    unresolved_modules: int
    problems: list[str] = Field(description="Rules-file entries that matched nothing or failed.")


class AnalysisStats(BaseModel):
    files_scanned: int
    files_parsed: int
    files_skipped: int  # unreadable, or past max_parse_bytes
    statements_found: int
    edges: int
    unresolved: int
    assets: int
    duration_ms: int


class Analysis(BaseModel):
    """The artifact. Written by the CLI, read by the server."""

    schema_version: int = SCHEMA_VERSION
    repo_path: str
    repo_name: str
    git_sha: str | None = None
    dirty: bool = False
    generated_at: datetime
    files: list[FileNode]
    edges: list[ImportEdge]
    unresolved: list[UnresolvedImport]
    external: dict[str, int] = Field(
        default_factory=dict,
        description="Non-repo specifiers and how often they are imported. Not graphed, "
        "but it is the cheapest available answer to 'what does this repo depend on'.",
    )
    assets: dict[str, int] = Field(
        default_factory=dict,
        description="Imported stylesheets, JSON, protos and the like. Real dependencies, "
        "but not code nodes, so they are counted instead of graphed.",
    )
    stats: AnalysisStats
    links: list[RuntimeLink] = Field(default_factory=list)
    link_stats: LinkStats


class Cluster(BaseModel):
    id: int
    label: str = Field(description="Longest common path prefix of the members. Not an LLM name.")
    color: str
    size: int
    distinct_color: bool = Field(
        description="True when this cluster owns its colour. The palette has ten entries; "
        "past the tenth, colour stops identifying anything and every remaining cluster "
        "shares one muted tone. A legend with four indistinguishable greys is lying about "
        "what colour means, so this says plainly which rows colour can be trusted on."
    )


class GraphNode(BaseModel):
    path: str
    language: Language
    cluster: int
    in_degree: int
    out_degree: int
    lines: int


class ViewStats(BaseModel):
    visible_files: int
    total_files: int
    visible_edges: int
    total_edges: int
    clusters: int
    visible_links: int
    total_links: int


class GraphView(BaseModel):
    """The filtered, clustered projection the browser renders."""

    nodes: list[GraphNode]
    edges: list[ImportEdge]
    clusters: list[Cluster]
    links: list[RuntimeLink] = Field(
        description="Runtime links whose ends are both visible. Not part of the partition."
    )
    stats: ViewStats


class RepoSummary(BaseModel):
    """One row in the repo picker. This is the cache's read path."""

    key: str
    repo_path: str
    repo_name: str
    git_sha: str | None
    dirty: bool
    generated_at: datetime
    files: int
    edges: int
    exists: bool = Field(description="False when the analysed path is gone from disk.")


class Health(BaseModel):
    """What this server is, which is also how the browser learns what it may offer.

    `read_only` true is the public deployment: the routes that act on the host
    are not registered, so the page hides the controls that would call them.
    The two roots, the pid and the build are stated only when it is not: they
    describe the host, and a visitor has no use for them.
    """

    status: Literal["ok"]
    read_only: bool
    cache_root: str | None = Field(
        default=None,
        description="Where analyses live. Also how `reposhape up` tells its own API from another "
        "checkout's on the same port.",
    )
    clone_root: str | None = Field(
        default=None, description="Where a cloned repo's checkout goes (ADR-0007)."
    )
    pid: int | None = Field(
        default=None,
        description="This server's process. `reposhape down` signals a registered pid only after "
        "the server at its URL has answered with it (ADR-0010).",
    )
    build: str | None = Field(
        default=None,
        description="The code and page this server started with. `reposhape up` replaces a server "
        "whose build is not its own.",
    )


class FolderEntry(BaseModel):
    """One directory the folder picker can offer. Never a file.

    `analysis_key` present means this folder is already in the cache, so the
    picker offers to open it rather than to analyse it. Same row, same click,
    different verb.
    """

    path: str = Field(description="Absolute, as this machine spells it.")
    name: str
    is_git: bool = Field(
        description="True when it holds a `.git`, which is what a repo looks like from outside."
    )
    analysis_key: str | None = None


class FolderListing(BaseModel):
    """One directory's child directories. The repo picker's write path.

    The browser cannot hand the server a filesystem path, so the folder chooser
    runs on the server side and this is what it answers with. Completion follows
    a shell's rule: a path ending in a separator lists that directory, anything
    else lists its parent filtered by `prefix`, so browsing and typing are one
    mechanism. `target` is the typed path itself when it is a directory, which
    is what makes the primary action available without picking a row first.
    """

    directory: str
    up: str | None = Field(description="The parent to climb to, or null at the filesystem root.")
    prefix: str
    entries: list[FolderEntry]
    target: FolderEntry | None = None
    truncated: bool = Field(
        description="True when the directory held more children than one listing returns."
    )


class GraphifyPageStatus(BaseModel):
    """Whether the symbol graph can be shown for this repo. The tab's read path.

    The symbol graph is graphify's own `graph.html`, served verbatim: this tool
    extracts files and imports only, and symbols are graphify's. It is not an
    analysis, so it has no cache key. `ready` false carries the CLI command
    that would make it ready, rather than a tab that fails when clicked.
    """

    ready: bool
    reason: str | None = None


class RepoPaths(BaseModel):
    """Every source path in the analysis, whatever the current filter.

    The path filter is a statement about the repository, not about the graph
    currently on screen. Built from the filtered view instead, a folder vanishes
    from the tree the moment you exclude it, and there is no row left to click
    to bring it back.
    """

    paths: list[str]
    test_paths: list[str]


class RepoLicense(BaseModel):
    """The license governing a file: the nearest one above it, read at request time.

    Shown beside every file the pane opens, because the page displays other
    people's code and the licenses this is used with (MIT first) permit that on
    condition the copyright and permission notice go with it. `path` null means
    no license file between the file and the repo root, which the pane says
    rather than showing nothing.
    """

    path: str | None = Field(
        description="The license file, repo-relative, or null when there is none. Not at "
        "the root when a package or plugin directory carries its own."
    )
    name: str | None = Field(
        description="SPDX id when the text is one this recognises, else null. Recognition "
        "is by the license's own fixed wording, so null means unrecognised, not absent."
    )
    copyright: list[str] = Field(description="The notice's copyright lines, as written.")
    text: str
    truncated: bool
    notice_path: str | None = Field(
        default=None,
        description="A NOTICE file beside the license, repo-relative. Apache-2.0 requires "
        "its contents to travel with the copies, so the pane shows it with the license.",
    )
    notice_text: str = ""
    notice_truncated: bool = False


class FileContents(BaseModel):
    path: str
    language: Language | None
    lines: int
    bytes: int
    truncated: bool
    text: str
