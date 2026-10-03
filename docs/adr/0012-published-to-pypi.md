# ADR-0012: Published to PyPI from GitHub Actions, with provenance

- Status: accepted
- Date: 2026-10-03

## Context

`reposhape up` is meant to be installed by people who never clone this repo:
`uv tool install reposhape`, `pipx install reposhape`, `uvx reposhape up`.
That needs a distribution on PyPI that runs without the checkout, and a way
of uploading it that a reader can trust.

Publishing the source distribution makes the backend's source public whatever
happens to the repository, so the repository is public too. That costs
nothing further and buys provenance: PyPI accepts PEP 740 attestations only
from a trusted publisher, and shows them, with the repository link marked
verified, only when the upload came from one.

## Decision

**Uploads come from `.github/workflows/release.yml` through trusted
publishing**, never from a laptop and never with a stored token. A version
tag (`v0.1.0`) publishes to PyPI; a manual run publishes the same build to
TestPyPI. The build job runs the gate and the package smoke test and keeps
the distributions; a separate publish job, the only one allowed an identity
token, attests them (`astral-sh/attest-action`) and uploads them
(`uv publish`). Each publish job names a GitHub environment, `pypi` or
`testpypi`, which the trusted publisher registered on that index must match.
The build refuses a tag that disagrees with `backend/pyproject.toml`, because
an index never accepts the same version twice.

**The wheel is the whole tool.** It carries the static export
(ADR-0008), and `backend/hatch_build.py` refuses to build a wheel or sdist
without it, so a package with nothing to show cannot be uploaded. MIT
licensed; the license text lives at the root and, because PEP 639 metadata may
only name files inside `backend/`, as a copy there that `just check` compares.

**The page's third-party notices ship beside it.** The export contains
minified copies of the frontend's runtime dependencies, whose licenses
require their notices to travel with them. `tools/third_party_notices.mjs`
writes `THIRD_PARTY_NOTICES.txt` from the production closure of the
frontend's direct dependencies, leaving out Next's build-time closure (sharp,
libvips, caniuse-lite, postcss), which never reaches the export. shiki is
imported fine-grained, so the export holds eight grammars and two themes
rather than all of them, and their upstream copyright holders are named in
the generator by hand.

**Dependency floors are the locked versions**, not older guesses. Installers
resolve fresh, and `tools/package_smoke.sh <dist> floors` installs exactly
the floors and drives the tool; `newest` does the same with whatever PyPI has
today. uvicorn is capped below the next minor because `daemon.py` overrides
`uvicorn.Server` internals. Python is capped below 3.15 until the smoke test
passes there.

**macOS and Linux only.** The background server is a POSIX session leader
stopped by signals (ADR-0010). The classifiers say so, and the CLI refuses on
Windows with one sentence rather than failing on `signal.SIGKILL` later.

## Consequences

- A release is: bump `version` in `backend/pyproject.toml`, commit, tag
  `vX.Y.Z`, push the tag. Nothing is uploaded by hand.
- Before the first upload, a pending trusted publisher must be registered on
  PyPI and on TestPyPI for `nabinpkl/reposhape`, workflow `release.yml`,
  environments `pypi` and `testpypi`. The first upload creates the project
  and claims the name.
- A new shiki language means a new entry in the generator's grammar origins.
- Raising the uvicorn cap or the Python cap is a `just package-smoke` run on
  the new version, then the edit.
- The release image (Dockerfile) builds the same wheel, so it writes the
  notices in its frontend stage and copies what the project build reads.
