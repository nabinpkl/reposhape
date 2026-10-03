/**
 * The path tree, as pure functions.
 *
 * The POC kept two parallel arrays of checkbox elements and a `syncCheckboxes()`
 * that walked them imperatively after every change. That made the DOM a second
 * source of truth for "what is excluded", which is why its tri-state went wrong
 * whenever the two drifted. Here nothing is stored: check state is derived from
 * the exclusion set at render time, so there is nothing to keep in sync.
 */

export interface PathNode {
  /** Segment name, for display. */
  name: string;
  /** Full repo-relative path. This is what the exclusion set holds. */
  path: string;
  isFile: boolean;
  /** Files at or under this node. Drives the count badge and bulk toggling. */
  fileCount: number;
  children: PathNode[];
}

interface Building {
  name: string;
  path: string;
  isFile: boolean;
  children: Map<string, Building>;
}

export function buildPathTree(paths: readonly string[]): PathNode[] {
  const root: Building = { name: "", path: "", isFile: false, children: new Map() };

  for (const full of paths) {
    const segments = full.split("/");
    let node = root;
    let prefix = "";
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!;
      prefix = prefix ? `${prefix}/${segment}` : segment;
      let child = node.children.get(segment);
      if (!child) {
        child = { name: segment, path: prefix, isFile: false, children: new Map() };
        node.children.set(segment, child);
      }
      if (index === segments.length - 1) child.isFile = true;
      node = child;
    }
  }

  return [...root.children.values()].map(freeze).sort(byFoldersThenName);
}

function freeze(node: Building): PathNode {
  const children = [...node.children.values()].map(freeze).sort(byFoldersThenName);
  const fileCount = node.isFile
    ? 1 + children.reduce((total, child) => total + child.fileCount, 0)
    : children.reduce((total, child) => total + child.fileCount, 0);
  return { name: node.name, path: node.path, isFile: node.isFile, fileCount, children };
}

/** Folders before files, then alphabetical. Matches every file tree a reader knows. */
function byFoldersThenName(a: PathNode, b: PathNode): number {
  const aIsFolder = a.children.length > 0;
  const bIsFolder = b.children.length > 0;
  if (aIsFolder !== bIsFolder) return aIsFolder ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/** Every file path at or under `node`. */
export function descendantFiles(node: PathNode, into: string[] = []): string[] {
  if (node.isFile) into.push(node.path);
  for (const child of node.children) descendantFiles(child, into);
  return into;
}

export type CheckState = "on" | "off" | "partial";

/**
 * Derived, never stored.
 *
 * A folder is excluded outright when its own path is in the set, which is how
 * excluding `app/wire` takes the subtree in one entry rather than in one
 * entry per file.
 */
export function checkStateOf(node: PathNode, excluded: ReadonlySet<string>): CheckState {
  if (excluded.has(node.path)) return "off";
  const files = descendantFiles(node);
  if (files.length === 0) return "on";
  let off = 0;
  for (const file of files) if (isExcluded(file, excluded)) off += 1;
  if (off === 0) return "on";
  if (off === files.length) return "off";
  return "partial";
}

/**
 * True when `path` is, or sits under, an excluded entry.
 *
 * Mirrors `graphing.path_is_excluded` on the backend, including the separator
 * check that stops `app/wire` swallowing `app/wire-utils`. The
 * duplication is deliberate and bounded: the server decides what is in the
 * graph, this only decides what a checkbox looks like. If they ever disagree
 * the visible symptom is a checkbox, not a wrong graph.
 */
export function isExcluded(path: string, excluded: ReadonlySet<string>): boolean {
  if (excluded.has(path)) return true;
  for (const entry of excluded) {
    if (path.startsWith(`${entry}/`)) return true;
  }
  return false;
}

/** Paths whose segments lead to `path`, for auto-expanding a search hit. */
export function ancestorsOf(path: string): string[] {
  const segments = path.split("/");
  const out: string[] = [];
  let prefix = "";
  for (const segment of segments.slice(0, -1)) {
    prefix = prefix ? `${prefix}/${segment}` : segment;
    out.push(prefix);
  }
  return out;
}
