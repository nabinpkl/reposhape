"""Refuse to build a package with no page in it.

The browser client is build output (`just web-export`) and gitignored, so a
fresh checkout has none, and hatch would happily package the Python alone: an
`reposhape up` that starts a server and has nothing to show. The third-party
notices travel with that page and are checked with it.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from hatchling.builders.hooks.plugin.interface import BuildHookInterface

REQUIRED = (
    "src/reposhape/web/index.html",
    "src/reposhape/web/THIRD_PARTY_NOTICES.txt",
)


class RequireWebBundle(BuildHookInterface):
    def initialize(self, version: str, build_data: dict[str, Any]) -> None:
        # An editable install is a checkout running its own source, where
        # `reposhape up` already refuses to start without the page, and
        # `uv run` makes one before `just web-export` has ever run.
        if version == "editable":
            return
        missing = [path for path in REQUIRED if not (Path(self.root) / path).is_file()]
        if missing:
            raise RuntimeError(
                f"cannot build reposhape without {', '.join(missing)}: run `just web-export` first"
            )
