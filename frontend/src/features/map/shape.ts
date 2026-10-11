import type { Cluster, GraphView } from "@/generated/contracts";

/**
 * What the map draws: a tree of files given by their paths, and nothing that
 * says what the files are.
 *
 * The map is a picture of folders. Imports, clusters and line counts are what
 * reposhape happens to know about a repo, so they come in through an adapter
 * (`fromGraphView`) rather than being read by the layout. Anything else that
 * is folders with files in them, a directory picked in the browser included,
 * gets its own adapter and the same drawing.
 */
export interface Shape {
  items: ShapeItem[];
  /**
   * The colour categories, in the wire's cluster shape so the legend reads
   * either. `distinct_color` false marks the ones sharing the overflow tone.
   */
  groups: Cluster[];
  /** Directed pairs of item paths. Empty when the source has no relations. */
  links: { source: string; target: string }[];
  /**
   * The smallest area a file gets when dots are sized, in `size` units.
   * Without it a tiny file beside a huge one is too small to see, and the map
   * stops being able to say that the small file exists.
   */
  sizeFloor: number;
}

export interface ShapeItem {
  /** Slash-separated and relative to the root. */
  path: string;
  /** What `folders · size` sizes by: lines for a repo, bytes for a folder. */
  size: number;
  /** A `groups` id, or null for an item that belongs to none. */
  group: number | null;
}

/**
 * A repo's view as a shape.
 *
 * A file with no imports either way is the backend's trailing "(no imports)"
 * bucket, which is an absence of community rather than a community, so it
 * gets no group. The size floor is seventy lines: below that a short module
 * is a speck beside a three-thousand-line one.
 */
export function fromGraphView(view: GraphView): Shape {
  return {
    items: view.nodes.map((node) => ({
      path: node.path,
      size: node.lines,
      group: node.in_degree + node.out_degree === 0 ? null : node.cluster,
    })),
    groups: view.clusters,
    links: view.edges,
    sizeFloor: 70,
  };
}
