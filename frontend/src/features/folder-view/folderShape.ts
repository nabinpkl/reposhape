import type { PickedFolder } from "@/features/folder-view/readFolder";
import type { Shape } from "@/features/map/shape";
import { OTHER_COLOR, PALETTE, type Cluster } from "@/generated/contracts";

/**
 * A picked folder as a shape: every file a dot, sized by its bytes, coloured
 * by its extension.
 *
 * Extension is the one thing every folder's files have, whatever is in them,
 * and it is what a reader means by "what kind of file". The commonest ten own
 * a colour; the rest share the overflow tone, as clusters past the tenth do,
 * because an eleventh colour would no longer tell anything apart.
 */
export function folderShape(folder: PickedFolder): Shape {
  const kinds = new Map<string, string[]>();
  for (const path of folder.files.keys()) {
    const kind = kindOf(path);
    const found = kinds.get(kind);
    if (found) found.push(path);
    else kinds.set(kind, [path]);
  }

  const ranked = [...kinds.entries()].sort(
    ([a, left], [b, right]) => right.length - left.length || a.localeCompare(b),
  );
  const groups: Cluster[] = ranked.map(([kind, paths], index) => ({
    id: index,
    label: kind,
    color: PALETTE[index] ?? OTHER_COLOR,
    size: paths.length,
    distinct_color: index < PALETTE.length,
  }));
  const groupOf = new Map(ranked.map(([kind], index) => [kind, index]));

  const items = [...folder.files.entries()].map(([path, file]) => ({
    path,
    size: file.size,
    group: groupOf.get(kindOf(path)) ?? null,
  }));

  return { items, groups, links: [], sizeFloor: floorOf(items.map((item) => item.size)) };
}

/**
 * `.ts`, `.png`, or the whole name for a dotfile (`.gitignore`), which has no
 * extension but is plainly its own kind. A name with no dot at all is
 * `no extension`, which is the honest label for a `Makefile` and a `LICENSE`
 * alike.
 */
export function kindOf(path: string): string {
  const name = path.split("/").at(-1) ?? path;
  const dot = name.lastIndexOf(".");
  if (dot === 0) return name.toLowerCase();
  if (dot < 0 || dot === name.length - 1) return "no extension";
  return name.slice(dot).toLowerCase();
}

/**
 * Half the median file, so a file well under typical is still a dot you can
 * see. Relative because bytes have no fixed scale: the floor that suits a
 * folder of source files would hide every file in a folder of photos.
 */
function floorOf(sizes: number[]): number {
  if (sizes.length === 0) return 1;
  const sorted = [...sizes].sort((a, b) => a - b);
  return Math.max(1, sorted[Math.floor(sorted.length / 2)]! / 2);
}
