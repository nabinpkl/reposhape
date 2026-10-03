# ADR-0010: The personal server runs in the background, and `reposhape up` returns

- Status: accepted
- Date: 2026-10-03

## Context

`reposhape up` ran uvicorn on a thread of its own process and held the terminal until
Ctrl-C. `launching.py` chose a thread over a subprocess on purpose: no child
process to reason about, and an import error surfacing in the CLI rather than in
a child's stderr.

That made the server's life the terminal's life. Closing a pane took the page
away from every tab that had it open, and a second repo's `reposhape up` only worked
while the first terminal stayed open. It also tied the command to a repo: there
was no way to open the picker without analysing whatever directory the shell
happened to be in, although the picker can already browse folders and clone
URLs on its own.

opencode, running on the same machine, has the shape wanted here: its CLI
starts `opencode serve` detached in its own session, finds it again through a
registration file under the XDG state directory, and stops it only after the
server it reaches has proved it is the registered one
(`packages/cli/src/services/daemon.ts`).

## Decision

**`reposhape up` makes sure a server is running, opens the page, and returns.** With no
argument it opens the picker. With `.`, a path or a git URL it analyses that
repo first, on the terminal with its progress, then opens its graph. `reposhape status`
reports the server and `reposhape down` stops it. `reposhape serve` stays the foreground
server for `just serve`; the release image runs uvicorn directly and is
untouched.

**The server is a separate process in its own session**
(`start_new_session=True`), so neither a hangup nor a Ctrl-C in the terminal
reaches it. Its working directory is `state_root`, so it holds open no directory
the owner may delete. Every setting the CLI resolved is passed to it through the
environment, so it serves exactly the cache and roots the CLI used. Its output
goes to `state_root/server.log`, and a start that fails quotes the log's tail:
this reverses the thread's one real advantage, so the failure path has to carry
what the thread used to surface for free.

**A registration file is the server's address, and it is checked before it is
believed.** `reposhape serve --register` writes `state_root/server.json` (`id`,
`build`, `url`, `pid`, `cache_root`) by rename, mode 0600, once it is listening,
and removes it on shutdown if it still names that server. It re-reads the file
every two seconds and leaves if it names another server, so a race between two
`reposhape up`s ends with one server.

**A pid is never signalled on the file's word.** `reposhape down`, and `reposhape up`
replacing a server, first require `/api/health` at the registered URL to answer
with the registered pid. Health states the pid and build in personal mode only;
read-only states neither.

**The build is part of the identity.** It is the package version joined to a
digest of the package's modules and the page's entry file. The version alone
does not move in an editable checkout or across `just web-export`, and a server
started before either would serve the old code with nothing saying so. `reposhape up`
replaces a server whose build is not its own.

**The port is fixed, and 7420 rather than 8000.** Fixed because the URL is
bookmarked and the theme is stored per origin. 8000 is the default of many
Python servers, and on the owner's machine another project's dashboard holds it.

## Consequences

- A server outlives the terminal by design, so its exposure does too. That is
  why the Host and Sec-Fetch-Site checks in `api.py` landed first: an always-on
  server on loopback with folder listing and clone routes is reachable from any
  page in the browser without them.
- A server can be left running indefinitely. `reposhape status` makes it findable and
  `reposhape down` stops it; nothing restarts it after a crash or a reboot, and the
  next `reposhape up` starts one. A launchd agent would add that, at the price of a
  macOS-only install step.
- `reposhape serve` run by hand on the same port is used as it is rather than replaced,
  because stopping a process this command did not start is not its call. Its
  build is not checked.
