# ADR-0014: a repo is untrusted content

- Status: accepted
- Date: 2026-10-06

## Context

An analysed repo is often someone else's: a URL pasted into Add repo, or a
public repo the hosted server shows. Four reads trusted it, and each was
shown to serve a host file through the read-only app:

- **Symlinks.** `git clone` checks a committed symlink out as a real one, and
  `git ls-files` lists it like any file. `x.py` pointing at `~/.ssh/id_rsa` was
  scanned, and `/api/file` served the key. The membership guard did not help,
  because the path was a member.
- The same link as `LICENSE` was served by `/api/license`, and as
  `graphify-out/graph.html` by `/api/graphify-page`.
- A tsconfig `extends` was resolved with nothing keeping it in the repo. Its
  content only steered alias resolution and was never served, but the repo
  still chose which host files were read.

Separately, a repo can commit `graphify-out/graph.html` itself. The iframe
sandboxes it, but opened in a tab of its own it ran as this origin, with the
operator routes (clone, analyze, folder listing) in reach.

## Decision

- **One check, `scanning.inside_repo`**: a path is read only when, with every
  symlink followed, it is still under the resolved repo root. Scanning drops
  any listed file that fails it, as the directory walk already skipped
  symlinks. Each route checks again when it reads, because a `git pull` can add
  a link after the analysis. tsconfig, `package.json`, `pnpm-workspace.yaml`
  and `pyproject.toml` reads go through it too.
- **The framed page carries `Content-Security-Policy: sandbox allow-scripts`.**
  The browser then sandboxes it however it is opened: its scripts run in an
  opaque origin, which the API refuses as cross-site.
- **Every other response carries a CSP** that allows scripts from this origin
  and the export's own inline scripts by hash. The hashes are read from the
  bundle when the server starts (`web_bundle.inline_script_hashes`), so they
  cannot drift from the pages being served. Styles allow inline: shiki colours
  tokens with style attributes, Radix's scroll lock writes a `<style>`, and
  a style cannot run code. The layout worker is built from a blob URL.
- **The highlighter uses shiki's JavaScript regex engine**, not Oniguruma.
  Compiling WASM would need `'wasm-unsafe-eval'` in that policy. All eight
  grammars run under the engine's strict mode.

## Consequences

- A file reached through a symlink out of the repo is not in the graph,
  rather than shown with a host file's content.
- A symlink that stays inside the repo still works.
- An `extends` into a shared config outside the repo is ignored, so its
  aliases do not resolve. TypeScript would follow it; this tool does not
  read outside the repo it was given.
- The scan resolves every listed path: about 0.14 s per 2,600 files.
- The CSP holds only for the page the Python server serves. `just web` serves
  the page from Next's dev server, which sends none.
