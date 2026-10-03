"""The browser client, as a static export built into this package.

`just web-export` builds the frontend with `output: "export"` and copies the
result here, and the wheel carries it (`[tool.hatch.build]` artifacts). One
server then answers both the page and `/api`, which is what lets `reposhape up` on
someone's own machine and the public deployment be the same artifact with one
setting different, and what lets `uvx` run this with no Node on the machine.

The directory is build output and gitignored. A checkout that has never run
the export has none, and `reposhape up` refuses to start rather than serving an API
with no page in front of it.
"""

from __future__ import annotations

from pathlib import Path

BUNDLE_DIR = Path(__file__).resolve().parent / "web"

# Where the frontend's source sits in a repo checkout. Absent in an installed
# wheel, which has no source to be newer than its bundle.
_FRONTEND_SRC = Path(__file__).resolve().parents[3] / "frontend" / "src"


def present() -> bool:
    return (BUNDLE_DIR / "index.html").is_file()


def staleness() -> str | None:
    """A sentence when the bundle predates the frontend source it was built from.

    Only meaningful in a checkout. Without it, editing the frontend and running
    `reposhape up` shows yesterday's page with nothing saying so, which reads as the
    edit not working.
    """
    if not present() or not _FRONTEND_SRC.is_dir():
        return None
    built = (BUNDLE_DIR / "index.html").stat().st_mtime
    newer = [
        path for path in _FRONTEND_SRC.rglob("*") if path.is_file() and path.stat().st_mtime > built
    ]
    if not newer:
        return None
    return (
        f"the browser client was built before {len(newer)} change(s) in frontend/src; "
        "run `just web-export` to see them."
    )
