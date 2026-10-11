# reposhape-viewer

React components that draw any folder tree as nested circles, with a file pane.

![The links view: langchain's files as nested circles, imports bundled over them](https://raw.githubusercontent.com/nabinpkl/reposhape/main/packages/viewer/screenshots/folders-links.jpg)

<sub>Screenshots: [langchain](https://github.com/langchain-ai/langchain) (MIT), 1,766 files, coloured by import cluster.</sub>

## Install

```sh
npm install reposhape-viewer
```

Needs React 18 or 19.

## Quick start

```tsx
import { FolderViewer } from "reposhape-viewer";
import "reposhape-viewer/style.css";

const data = {
  files: [
    { path: "src/index.ts", size: 1200 },
    { path: "src/lib/shape.ts", size: 5400 },
    { path: "README.md", size: 800 },
  ],
};

const loadFile = async (path: string) => ({
  kind: "text" as const,
  text: await (await fetch(`/files/${path}`)).text(),
});

export default function App() {
  return (
    <div style={{ height: 600 }}>
      <FolderViewer data={data} loadFile={loadFile} />
    </div>
  );
}
```

Click a folder to zoom in, click a file to open it, double-click to zoom back out.

## Views

**folders**: one dot per file.

![folders view](https://raw.githubusercontent.com/nabinpkl/reposhape/main/packages/viewer/screenshots/folders.jpg)

**folders · size**: dot area is the file's `size`.

![folders · size view](https://raw.githubusercontent.com/nabinpkl/reposhape/main/packages/viewer/screenshots/folders-size.jpg)

**folders · links**: your `links` drawn over the folders (the image at the top).

## File pane

![Map with a file selected and the file pane open](https://raw.githubusercontent.com/nabinpkl/reposhape/main/packages/viewer/screenshots/file-pane.jpg)

Use the map and the pane separately for your own layout:

```tsx
import { FilePane, FolderMap } from "reposhape-viewer";

const [path, setPath] = useState<string | null>(null);

<FolderMap data={data} selected={path} onSelect={setPath} />
{path && <FilePane path={path} load={loadFile} onClose={() => setPath(null)} />}
```

## Data

```ts
type FolderData = {
  files: { path: string; size?: number; group?: string | null }[];
  groups?: { id: string; label?: string; color?: string }[];
  links?: { source: string; target: string }[];
  sizeLabel?: string; // "bytes", "lines"
};

type FileContent =
  | { kind: "text"; text: string }
  | { kind: "image"; src: string }
  | { kind: "binary" };
```

- Folders come from the paths.
- No `group`? Files are coloured by extension.
- Text is syntax highlighted for TS, JS, Vue, Python, JSON and CSS.

## Local files

Show a folder the user picks, without a server:

```tsx
import { readBrowserFile } from "reposhape-viewer";

<input
  type="file"
  // @ts-expect-error: not in React's types
  webkitdirectory=""
  onChange={(e) => {
    const files = new Map([...e.target.files!].map((f) => [f.webkitRelativePath, f]));
    setData({ files: [...files].map(([path, f]) => ({ path, size: f.size })) });
    setLoad(() => (path: string) => readBrowserFile(files.get(path)!));
  }}
/>
```

## Props

| `FolderViewer` | |
| --- | --- |
| `data` | `FolderData` |
| `loadFile` | `(path) => Promise<FileContent>` |
| `theme` | `"dark"` (default) or `"light"` |
| `initialView` | `"files"`, `"size"` or `"links"` |
| `highlight` | dims files whose path doesn't contain this text |

| `FolderMap` | |
| --- | --- |
| `data` | `FolderData` |
| `sizing` | `"files"` or `"size"` |
| `links` | draw `data.links` |
| `theme` | `"dark"` or `"light"` |
| `selected`, `onSelect` | the selected file path |
| `highlight`, `dimmed` | dim files by text or by path set |
| `onOpenFile`, `onDismiss` | file clicked, empty space clicked |

| `FilePane` | |
| --- | --- |
| `path` | file to show |
| `load` | `(path) => Promise<FileContent>` |
| `onClose` | shows a close button |
| `theme` | `"dark"` or `"light"` |

## Styling

Override CSS variables:

```css
.rs-viewer[data-theme] {
  --rs-canvas: #0b0d12;
  --rs-panel: #12151c;
  --rs-accent: #7aa2f7;
}
```

Also `--rs-fg`, `--rs-muted`, `--rs-line`, `--rs-font`, `--rs-font-mono`, `--rs-aside-width`.

## Notes

- Works in Next.js server components (ships with `"use client"`).
- No WebAssembly, so a strict CSP is fine.
- Tested up to about 20,000 files.

## License

MIT
