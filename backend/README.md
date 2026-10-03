# reposhape

reposhape draws a map of a codebase: every file, the folder it sits in, and
which files import which. It reads TypeScript, JavaScript, Vue and Python,
runs on your machine, and opens the map in your browser.

![LangChain's monorepo as a map: folders as circles, files as dots sized by line count](https://raw.githubusercontent.com/nabinpkl/reposhape/main/docs/images/langchain-map-lines.jpg)

*LangChain, 1,766 source files with tests hidden. Each circle is a folder and
each dot is a file, sized by its line count. Colours are clusters worked out
from the imports.*

![The same map with the imports that cross between packages drawn on top](https://raw.githubusercontent.com/nabinpkl/reposhape/main/docs/images/langchain-map-edges.jpg)

*The same repo with the imports that cross from one package to another drawn
on top.*

## Install

You need Python 3.14 on macOS or Linux.

```bash
uv tool install reposhape
```

`pipx install reposhape` works too.

## Quick start

```bash
cd path/to/your/repo
reposhape up .
```

This analyses the repo, starts a small local server and opens the map. The
server keeps running after you close the terminal. `reposhape down` stops it.

| Command | What it does |
| --- | --- |
| `reposhape up .` | Analyse the current repo and open its map |
| `reposhape up <url>` | Clone a repo, analyse it and open its map |
| `reposhape up` | Open the page on the repo picker |
| `reposhape status` | Show whether the server is running, and where |
| `reposhape down` | Stop the server |

## Privacy

Your code is parsed locally with tree-sitter. No LLM and no outside service
is involved. The server only listens on 127.0.0.1 and rejects requests from
other websites.

## More

Docs, source and issues: <https://github.com/nabinpkl/reposhape>. MIT licensed.
