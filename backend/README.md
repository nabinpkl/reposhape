# reposhape

See the shape of a repository at a glance. Point it at a repo and get an
interactive map of *your* code's file-level imports, with vendored and
generated trees scoped out and clusters computed over import edges only. No
LLM, no external analyser, nothing leaves your machine.

TypeScript, JavaScript (including Vue single-file components) and Python are
parsed with tree-sitter; each import is resolved to a real file in the repo or
recorded with the reason it could not be.

## Install

Python 3.14, macOS or Linux:

```bash
uv tool install reposhape    # or: pipx install reposhape
```

## Use

```bash
cd path/to/a/repo && reposhape up .          # analyse this repo, open its graph
reposhape up                                 # open the repo picker
reposhape up https://github.com/owner/repo   # clone it, keep it, open it
reposhape status                             # where the background server is
reposhape down                               # stop it
```

The server keeps running in the background after the terminal closes, listens
on 127.0.0.1 only, and refuses requests from other sites and other host names.

Source, docs and issues: <https://github.com/nabinpkl/reposhape>. MIT licensed.
