import { OTHER_COLOR, PALETTE } from "./palette";

/**
 * What the viewer draws: files given by their paths, and nothing that says
 * what the files are.
 *
 * The map is a picture of folders. Whatever a source knows beyond paths (a
 * repo's import clusters and line counts, a folder's byte sizes) comes in as
 * an optional size, an optional group and optional links. Everything else is
 * derived here, once, so every view of the same data agrees.
 */
export interface FolderData {
  files: FolderFile[];
  /**
   * The colour categories `group` refers to. Omitted, files are grouped by
   * their `group` string, or by extension when that is missing too.
   */
  groups?: FolderGroup[];
  /** Directed pairs of file paths, drawn by `FolderMap` with `links`. */
  links?: FolderLink[];
  /** What `size` measures, for labels: "bytes", "lines". */
  sizeLabel?: string;
  /**
   * The smallest area a file gets when dots are sized, in `size` units.
   * Defaults to half the median size: below that a small file beside a huge
   * one is too small to see, and the map stops saying the small file exists.
   */
  sizeFloor?: number;
}

export interface FolderFile {
  /** Slash-separated, relative to the root: `src/lib/shape.ts`. */
  path: string;
  /** What the size view sizes by. Omitted on every file, there is no size view. */
  size?: number;
  /**
   * A group key: an id from `groups`, or any string when `groups` is omitted.
   * `null` puts the file in no group (drawn neutral); omitted with no `groups`,
   * the file's extension is its group.
   */
  group?: string | null;
}

export interface FolderGroup {
  id: string;
  label?: string;
  /** Any CSS hex. Omitted, the group takes the next palette colour by size. */
  color?: string;
}

export interface FolderLink {
  source: string;
  target: string;
}

/** `FolderData` resolved: every file placed in a numbered group with a colour. */
export interface Shape {
  items: ShapeItem[];
  groups: ShapeGroup[];
  links: FolderLink[];
  sizeFloor: number;
  /** False when no file carried a size, so there is nothing to size by. */
  hasSizes: boolean;
}

export interface ShapeItem {
  path: string;
  size: number;
  /** An index into `groups`, or null for a file in none. */
  group: number | null;
}

export interface ShapeGroup {
  id: number;
  /** The key files named it by. */
  key: string;
  label: string;
  color: string;
  /** Files in it. */
  size: number;
  /**
   * True when no other group shares its colour. Past the palette's ten, the
   * rest share one tone, and colour stops telling them apart.
   */
  distinct: boolean;
}

/**
 * `FolderData` to the shape every view draws.
 *
 * Groups given are kept in the order given, which is the caller's ranking.
 * Groups derived (from `group` strings or extensions) are ranked by how many
 * files they hold, and the commonest ten own a palette colour.
 */
export function toShape(data: FolderData): Shape {
  const keyOf = (file: FolderFile): string | null =>
    file.group === null ? null : (file.group ?? (data.groups ? null : kindOf(file.path)));

  const counts = new Map<string, number>();
  for (const file of data.files) {
    const key = keyOf(file);
    if (key !== null) counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  let groups: ShapeGroup[];
  if (data.groups) {
    // Uncoloured groups take palette colours largest first.
    const uncoloured = data.groups
      .filter((group) => !group.color)
      .sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0) || a.id.localeCompare(b.id));
    const assigned = new Map(uncoloured.map((group, rank) => [group.id, PALETTE[rank] ?? OTHER_COLOR]));
    groups = data.groups.map((group, index) => ({
      id: index,
      key: group.id,
      label: group.label ?? group.id,
      color: group.color ?? assigned.get(group.id)!,
      size: counts.get(group.id) ?? 0,
      distinct: false,
    }));
  } else {
    groups = [...counts.entries()]
      .sort(([a, left], [b, right]) => right - left || a.localeCompare(b))
      .map(([key, size], index) => ({
        id: index,
        key,
        label: key,
        color: PALETTE[index] ?? OTHER_COLOR,
        size,
        distinct: false,
      }));
  }
  const sharing = new Map<string, number>();
  for (const group of groups) sharing.set(group.color, (sharing.get(group.color) ?? 0) + 1);
  for (const group of groups) group.distinct = sharing.get(group.color) === 1;

  const indexOf = new Map(groups.map((group) => [group.key, group.id]));
  const hasSizes = data.files.some((file) => file.size !== undefined);
  const items = data.files.map((file) => {
    const key = keyOf(file);
    return {
      path: file.path,
      size: file.size ?? 1,
      group: key === null ? null : (indexOf.get(key) ?? null),
    };
  });

  return {
    items,
    groups,
    links: data.links ?? [],
    sizeFloor: data.sizeFloor ?? halfMedian(items.map((item) => item.size)),
    hasSizes,
  };
}

/**
 * `.ts`, `.png`, or the whole name for a dotfile (`.gitignore`), which has no
 * extension but is plainly its own kind. A name with no dot at all is
 * `no extension`, the honest label for a `Makefile` and a `LICENSE` alike.
 */
export function kindOf(path: string): string {
  const name = path.split("/").at(-1) ?? path;
  const dot = name.lastIndexOf(".");
  if (dot === 0) return name.toLowerCase();
  if (dot < 0 || dot === name.length - 1) return "no extension";
  return name.slice(dot).toLowerCase();
}

/**
 * Relative because sizes have no fixed scale: the floor that suits a folder
 * of source files would hide every file in a folder of photos.
 */
function halfMedian(sizes: number[]): number {
  if (sizes.length === 0) return 1;
  const sorted = [...sizes].sort((a, b) => a - b);
  return Math.max(1, sorted[Math.floor(sorted.length / 2)]! / 2);
}
