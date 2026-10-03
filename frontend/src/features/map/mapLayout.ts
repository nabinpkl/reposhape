import { hierarchy, pack } from "d3-hierarchy";

import { SCHEMES, discColor, type ColorScheme } from "@/features/graph/graphModel";
import type { GraphView } from "@/generated/contracts";

/**
 * The repo as nested circles: every file one dot, folders the circles around
 * them. No edges, which is the point rather than an omission.
 *
 * The graph canvas draws relations and cannot draw all of them: at 2,581 files
 * its 5,451 curves are what the eye reads first, and the discs stop being
 * individually visible. Drop the edges and every file fits on screen at once.
 * Position then spends itself on the folder tree and colour carries the only
 * import fact left, the Louvain community, which is what makes this a map of
 * the repo rather than a file browser: a folder whose dots are one colour is a
 * place, and one with four colours is a pile.
 *
 * Geometry is computed once per view and never again. Zoom moves the camera
 * over a fixed drawing; it does not re-layout, so the picture is identical
 * every time the tab is opened and a reader can learn where things are.
 */

/** Layout units. The camera fits this square to the pane. */
export const MAP_SIZE = 1000;

/**
 * Screen radius under which a folder stays one dot instead of opening.
 *
 * It lives here rather than in the renderer because it is not only a drawing
 * rule: it decides which circles EXIST on screen, and so where an edge has to
 * end and what the cursor can be over. Three readers of one number.
 */
export const COLLAPSE = 13;

/**
 * What a dot's area means, and the two answers disagree enough to be worth
 * having both.
 *
 * `files` gives every file one dot of one size, so a folder's circle is sized
 * by HOW MANY files are in it. That is the question a layout rule asks (one
 * repo measured here gates directory fan-out at twelve), and it is the one where
 * colour proportion inside a folder can be read honestly, because no dot is
 * big enough to dominate the impression.
 *
 * `lines` sizes a dot by its file's length, so a folder is sized by how much
 * code is in it. Measured on a private monorepo, the two name different things as the
 * largest object in the repo, so neither is a refinement of the other.
 */
export type Sizing = "files" | "lines";

/** A file with no import at all carries no community, so it gets the neutral. */
const ISOLATED_CLUSTER = -1;

export interface MapCircle {
  /** Repo-relative path. A folder's is its directory path. */
  path: string;
  /** Last segment, which is what gets drawn. */
  name: string;
  depth: number;
  x: number;
  y: number;
  r: number;
  isFile: boolean;
  /** The disc colour: a file's own community, a folder's most common one. */
  ink: string;
  /** Files at or under this circle. */
  files: number;
  /** Zero for a folder. */
  lines: number;
  children: MapCircle[];
}

interface Building {
  name: string;
  path: string;
  lines: number;
  cluster: number;
  children: Map<string, Building>;
}

interface Packed {
  name: string;
  path: string;
  lines: number;
  cluster: number;
  children?: Packed[];
}

/**
 * Gaps between siblings, by the depth of the circle they sit inside. Wide at
 * the top so the repo's own directories stand apart, narrow at the bottom so
 * sibling files stop just short of touching. This is the whole control over
 * whether the drawing reads as dots with air or as a mass.
 */
const PADDING: Record<Sizing, readonly number[]> = {
  files: [14, 8, 4.5, 2.4, 1.7],
  lines: [16, 9, 5, 2.8, 2],
};

/**
 * A floor on a file's area in `lines` mode. Without it a twelve-line module is
 * a dot too small to see beside a three-thousand-line one, and the map stops
 * being able to say that the small file exists.
 */
const MIN_LINES = 70;

function build(view: GraphView): Packed {
  const root: Building = { name: "", path: "", lines: 0, cluster: ISOLATED_CLUSTER, children: new Map() };
  for (const node of view.nodes) {
    let current = root;
    let prefix = "";
    const segments = node.path.split("/");
    segments.forEach((segment, index) => {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      let child = current.children.get(segment);
      if (!child) {
        child = { name: segment, path: prefix, lines: 0, cluster: ISOLATED_CLUSTER, children: new Map() };
        current.children.set(segment, child);
      }
      current = child;
      if (index === segments.length - 1) {
        current.lines = node.lines;
        // Degree zero is the backend's trailing "(no imports)" bucket, which is
        // an absence of community rather than a community.
        current.cluster =
          node.in_degree + node.out_degree === 0 ? ISOLATED_CLUSTER : node.cluster;
      }
    });
  }

  const freeze = (node: Building): Packed => ({
    name: node.name,
    path: node.path,
    lines: node.lines,
    cluster: node.cluster,
    children: node.children.size > 0 ? [...node.children.values()].map(freeze) : undefined,
  });
  return freeze(root);
}

export function packView(view: GraphView, sizing: Sizing, scheme: ColorScheme): MapCircle {
  const colors = SCHEMES[scheme];
  const paletteOf = new Map(view.clusters.map((cluster) => [cluster.id, cluster.color]));
  // Cluster discs go through full value the way the graph canvas draws them,
  // so the same file is the same colour in both tabs. Isolates deliberately do
  // NOT: full value takes the neutral to near-white, which is the selection
  // colour on this ground, and there are enough files with no imports here
  // (280 of one monorepo's 1,275) that a white one draws the eye before any
  // cluster does. Raw neutral reads as "no community" rather than as emphasis.
  const inkOf = (cluster: number) =>
    cluster === ISOLATED_CLUSTER
      ? colors.isolated
      : discColor(paletteOf.get(cluster) ?? colors.fallback, scheme);

  const tree = hierarchy<Packed>(build(view), (node) => node.children)
    .sum((node) =>
      node.children ? 0 : sizing === "files" ? 1 : Math.max(node.lines || 1, MIN_LINES),
    )
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

  const gaps = PADDING[sizing];
  const packed = pack<Packed>()
    .size([MAP_SIZE, MAP_SIZE])
    .padding((node) => gaps[Math.min(node.depth, gaps.length - 1)]!)(tree);

  const convert = (node: typeof packed): MapCircle => {
    const children = (node.children ?? []).map(convert);
    const isFile = children.length === 0;
    let ink: string;
    if (isFile) {
      ink = inkOf(node.data.cluster);
    } else {
      // A folder takes the community most of its files belong to. A folder that
      // is one thing therefore reads as one colour at any zoom, and one that is
      // a pile only looks solid until you open it -- which is the honest
      // failure, because opening it is one gesture away.
      const tally = new Map<string, number>();
      const stack = [...children];
      let dominant: string = colors.fallback;
      let best = 0;
      while (stack.length > 0) {
        const circle = stack.pop()!;
        if (circle.isFile) {
          const count = (tally.get(circle.ink) ?? 0) + 1;
          tally.set(circle.ink, count);
          if (count > best) {
            best = count;
            dominant = circle.ink;
          }
        } else {
          stack.push(...circle.children);
        }
      }
      ink = dominant;
    }
    return {
      path: node.data.path,
      name: node.data.name,
      depth: node.depth,
      x: node.x,
      y: node.y,
      r: node.r,
      isFile,
      ink,
      files: isFile ? 1 : children.reduce((total, child) => total + child.files, 0),
      lines: isFile ? node.data.lines : 0,
      children,
    };
  };
  return convert(packed);
}
