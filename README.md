# reposhape

See the shape of a repository at a glance. Point it at a repo and get the
file-level import graph of *your* code, with vendored and generated trees
scoped out and clusters computed over import edges only. No LLM, no external
analyser, nothing leaves your machine.

TypeScript, JavaScript (including Vue single-file components) and Python are
parsed with tree-sitter; each import is resolved to a real file in the repo or
recorded with the reason it could not be.

## Install

Python 3.14, macOS or Linux:

```bash
uv tool install reposhape    # or: pipx install reposhape
```

`uvx reposhape up` runs it without installing.

## Use

```bash
cd path/to/a/repo && reposhape up .   # analyse this repo, open its graph
reposhape up                          # from anywhere: open the repo picker
reposhape up https://github.com/owner/repo   # clone it, keep it, open it
```

```
  repo  /home/you/code/my-app  (1,259 files, 3,247 edges)
  open  http://127.0.0.1:7420/?repo=my-app-ee3643bb40cb
```

`reposhape up .` analyses the repo you are standing in (the git root, not the
subdirectory), reuses a cached analysis unless you pass `--refresh`, makes sure
the server is running, and opens the URL. Bare `reposhape up` opens the page on
the picker, where a folder or a git URL is added. Either way it returns: the
server keeps running in the background after the terminal closes,
`reposhape status` says where, and `reposhape down` stops it. An upgrade is
picked up by the next `reposhape up`, which replaces a server running an older
build.

The server listens on 127.0.0.1 only, and refuses requests that arrive under
another host name or from another site, so a web page you have open cannot
read your files through it.

A repo that is not on this machine yet is cloned first: `reposhape clone <url>`,
`reposhape up <url>`, or **Add repo** in the browser. The checkout is durable,
not temporary. It lands in `~/.local/share/reposhape/clones` as
`<host>/<owner>/<name>` (`REPOSHAPE_CLONE_ROOT` moves it) and stays there:
`reposhape forget` clears the analysis, never the checkout. Clones are shallow;
`git fetch --unshallow` in one if you want its history.

Scope is a decision, not a statistic: copy
[`.reposhapeignore.example`](.reposhapeignore.example) into the repo you are
analysing as `.reposhapeignore` and edit it. It is gitignore syntax, merged on
top of the repo's `.gitignore`.

Analyses are cached in `~/.cache/reposhape`; settings come from `REPOSHAPE_*`
environment variables, never from a `.env` in the repo being analysed.

## Hosting a read-only copy

`REPOSHAPE_READ_ONLY=true` serves the repos an operator cloned there and
nothing else: the routes that browse, clone, analyse or forget are never
registered. The `Dockerfile` and `compose.release.yaml` build and run that
image; `just release` deploys it to a host over SSH, configured by
`ops/deployments/hosted.env` (copy `hosted.env.example`). See ADR-0008.

## Develop

Needs uv, pnpm and [just](https://github.com/casey/just).

```bash
just install       # build the page, put `reposhape` on PATH from this checkout
just check         # lint, types, tests, contracts, the static export
just web           # frontend dev server with hot reload, proxying /api to `just serve`
just web-export    # rebuild the page the Python package serves
just package-smoke # build the wheel and sdist, install each and drive it
```

The page is a static export built into the Python package, so there is no Node
at run time. In a checkout, `reposhape up` warns when that copy is older than
`frontend/src`.

The CLI writes the analysis; the server only reads it. One analysis path, so
`reposhape analyze-repo` and `POST /api/analyze` cannot drift.

What it is and why it exists: [`PRD.md`](PRD.md). How it is built:
[`SPEC.md`](SPEC.md). Decisions: [`docs/adr/`](docs/adr/).

## License

MIT. See [`LICENSE`](LICENSE).
