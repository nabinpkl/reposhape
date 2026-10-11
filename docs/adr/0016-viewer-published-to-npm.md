# ADR-0016: The folder views are a React package on npm

- Status: accepted
- Date: 2026-10-11

## Context

0.1.6 made the folder map draw any tree of files (`/view` draws a folder picked
in the browser), which showed the map and the file pane were never about
imports: they draw paths, an optional size, an optional colour group and
optional links. Other people have folders with files in them that are not
repositories, and other apps want the picture without reposhape's server.

The map and pane still reached into the app: `next-themes` and a check of
`<html class="light">` for the theme, the app's zustand store for selection,
search and dimming, Tailwind classes resolved by the app's token layer, and
colour helpers in a module that imports graphology.

## Decision

**`packages/viewer` is the folder views as a library, `reposhape-viewer` on
npm**, in this repo's pnpm workspace:

- `FolderViewer` (view switch, map, pane), `FolderMap` and `FilePane`, plus
  `CodeBlock`, `readBrowserFile` and `toShape`. No folder picker, legend or
  filters: those stay the app's.
- **They draw `FolderData`**: files by path, each with an optional size and
  group, optional groups with colours, optional links. Grouping by extension,
  palette assignment and the size floor are derived in one place (`toShape`).
- **Props, not app state.** Theme, selection, highlight and dimming are
  controlled props; the pane's content comes from a `load` function, so it
  never fetches.
- **A shipped stylesheet with CSS variables** under `.rs-viewer`; the app maps
  its own tokens onto them, so the pane looks native in both.
- **The app is a consumer like any other.** `frontend` depends on
  `reposhape-viewer: workspace:*` and imports its `dist/`, built by tsdown.
  Import wording ("imports / importers", "repo root") and the store wiring
  live in `frontend/src/features/map/`.
- **One palette.** `tools/export_contracts.py` writes the backend's `PALETTE`
  and `OTHER_COLOR` into `packages/viewer/src/palette.ts`, so a cluster and an
  extension group are coloured from the same list.
- **Published from `.github/workflows/viewer-release.yml` through trusted
  publishing**, as ADR-0012 does for PyPI: a `viewer-vX.Y.Z` tag publishes, the
  build refuses a tag that disagrees with `package.json`, and only the publish
  job may request an identity token, under the GitHub environment `npm`. npm
  generates the provenance attestation itself. Versioned apart from the
  Python package: the components and the CLI change for different reasons.

## Consequences

- Moving the code changed no pixel: the folder, size and imports views of
  three repos in both themes hash the same before and after, 18 of 18, against
  0.1.6 run on the same networkx (3.6.1).
- A theme switch now re-packs the inks without moving the camera. Before, the
  packed inks kept the scheme of the first render until the data changed.
- `just check` gains `check-viewer`: types, the build, tests against the build,
  and the exact file list `npm pack` would publish. `check-frontend`,
  `web-export` and the image build the package first.
- tsdown is pre-1.0 and pinned exactly (0.23.0; 0.23.1 was inside the
  workspace's minimum release age when this landed).
- The first publish needs the trusted publisher configured on npmjs.com for
  `reposhape-viewer`, by the account that will own it.
