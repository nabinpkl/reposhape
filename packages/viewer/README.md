# reposhape-viewer

Any tree of files as nested circles, with a file pane. These are the React
components behind [reposhape](https://github.com/nabinpkl/reposhape)'s folder
views, packaged to draw any data that has folders and files in it: a
repository, a picked directory, a bucket listing, an archive's table of contents.

Every file is a dot and every folder is the circle around its files. Clicking a
folder flies into it, clicking a file selects it and opens it in the pane, the
wheel or a pinch zooms, dragging pans, and a double click fits the whole tree
again. One canvas, drawn by hand: 1,766 files redraw in about a millisecond.

![FolderViewer drawing langchain's 1,766 source files: libs/langchain, core, partners and the rest as nested circles, each file a dot coloured by its import cluster](https://raw.githubusercontent.com/nabinpkl/reposhape/main/packages/viewer/screenshots/folders.jpg)

Every screenshot here is this package drawing
[langchain-ai/langchain](https://github.com/langchain-ai/langchain) (MIT) at
commit `c01de7f`: its 1,766 source files with tests left out, each coloured by
the import cluster [reposhape](https://github.com/nabinpkl/reposhape) found,
with line counts as sizes and the 3,642 imports between them as links.

```sh
npm install reposhape-viewer
```

React 18 or 19 is a peer dependency.

## Use

```tsx
import { FolderViewer, type FileContent, type FolderData } from "reposhape-viewer";
import "reposhape-viewer/style.css";

const data: FolderData = {
  files: [
    { path: "src/index.ts", size: 1200 },
    { path: "src/lib/shape.ts", size: 5400 },
    { path: "README.md", size: 800 },
  ],
  sizeLabel: "bytes",
};

async function loadFile(path: string): Promise<FileContent> {
  const response = await fetch(`/files/${path}`);
  return { kind: "text", text: await response.text() };
}

export function Files() {
  return (
    <div style={{ height: 600 }}>
      <FolderViewer data={data} loadFile={loadFile} theme="dark" />
    </div>
  );
}
```

`FolderViewer` fills its box, so give it, or its parent, a height. Keep
`loadFile` stable (define it outside the component, or wrap it in
`useCallback`): the pane reloads when it changes.

### The views

- **folders**: one dot per file, so a folder's circle says how many files it holds.
- **folders · size**: a dot's area is its file's `size`. Offered when the data has sizes.
- **folders · links**: `links` drawn over the folders, bundled up the folder
  tree. Links that leave their package are emphasised; hovering a circle shows
  its own links both ways with arrows. Offered when the data has links.

![folders · size: the same tree with each dot's area set by the file's line count, so the anthropic and openrouter partner packages stand out as single large files](https://raw.githubusercontent.com/nabinpkl/reposhape/main/packages/viewer/screenshots/folders-size.jpg)

![folders · links: imports drawn over the folders and bundled into trunks, with the ones leaving their package, such as partners into core, in their cluster's colour](https://raw.githubusercontent.com/nabinpkl/reposhape/main/packages/viewer/screenshots/folders-links.jpg)

## The data

```ts
interface FolderData {
  files: { path: string; size?: number; group?: string | null }[];
  groups?: { id: string; label?: string; color?: string }[];
  links?: { source: string; target: string }[];
  sizeLabel?: string; // what `size` measures, for labels: "bytes", "lines"
  sizeFloor?: number; // smallest area a file gets in the size view
}
```

- **Paths** are slash-separated and relative to the root. Folders come from the
  paths; there is no separate folder list.
- **Colour** comes from groups. With no `groups`, files are grouped by their
  `group` string, or by extension when that is missing too (`.ts`, `.png`,
  `.gitignore`, `no extension`). Groups are ranked by size, and the ten largest
  own a colour from a colour-blind-safe palette; the rest share one tone,
  because an eleventh colour would no longer tell anything apart. With
  `groups`, their order and colours are kept, and `group: null` leaves a file
  neutral.
- **Sizes** default the floor to half the median size, so a small file beside a
  huge one is still a visible dot.

`toShape(data)` returns the resolved groups and colours, for a legend of your own.

## The parts

`FolderViewer` is `FolderMap` and `FilePane` with a view switch. Use the parts
for a layout of your own:

```tsx
import { FilePane, FolderMap } from "reposhape-viewer";

<FolderMap
  data={data}
  sizing="files" // or "size"
  links={false}
  theme="dark"
  selected={path}
  onSelect={setPath} // a file's path, or null for empty ground
  highlight="src/" // files containing this text stay lit, the rest dim
  dimmed={new Set<string>()}
  onOpenFile={open}
  onDismiss={close}
  labels={{ root: "repo root", linkOut: (n) => `${n} imports`, linkIn: (n) => `${n} importers` }}
/>

<FilePane path={path} load={loadFile} onClose={close} theme="dark" />
```

`FilePane` takes `children`, rendered between its meta line and the content,
for rows of your own. `CodeBlock` is the pane's code view on its own.

![FolderMap with langchain_core/messages/ai.py selected, and FilePane beside it showing the file highlighted: 854 lines, 28.5 KB](https://raw.githubusercontent.com/nabinpkl/reposhape/main/packages/viewer/screenshots/file-pane.jpg)

### File content

```ts
type FileContent =
  | { kind: "text"; text: string; size?: number; truncated?: boolean }
  | { kind: "image"; src: string; size?: number; dispose?: () => void }
  | { kind: "binary"; size?: number };
```

Text is highlighted with [shiki](https://shiki.style) when its extension is
TypeScript, JavaScript, JSX/TSX, Vue, Python, JSON or CSS, and shown with line
numbers otherwise. Shiki loads on the first text file, not before.

`readBrowserFile(file)` turns a browser `File` (from an `<input type="file">`,
a drop, the File System Access API) into content: an image by its MIME type,
binary when its first 8,000 bytes hold a NUL byte, text otherwise, cut at
512 KB.

## Styling

`style.css` styles the pane, the tabs and the code. Every colour is a CSS
variable on `.rs-viewer`, so restyling means overriding variables:

```css
.rs-viewer[data-theme] {
  --rs-canvas: #0b0d12;
  --rs-panel: #12151c;
  --rs-accent: #7aa2f7;
}
```

The variables are `--rs-canvas`, `--rs-panel`, `--rs-line`,
`--rs-line-strong`, `--rs-fg`, `--rs-muted`, `--rs-faint`, `--rs-accent`,
`--rs-danger`, `--rs-warn`, `--rs-font`, `--rs-font-mono` and
`--rs-aside-width`. The map's canvas takes its colours from the `theme` prop.

## Notes

- **Next.js:** the build starts with `"use client"`, so a server component can
  import it directly.
- **Content Security Policy:** highlighting uses shiki's JavaScript regex
  engine, not WebAssembly, so no `'wasm-unsafe-eval'` is needed.
  `readBrowserFile` images are `blob:` URLs, which `img-src` has to allow.
- **Size:** packing and drawing were measured up to about 20,000 files.

## License

MIT
