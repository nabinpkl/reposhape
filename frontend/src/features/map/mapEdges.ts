import { COLLAPSE, type MapCircle } from "@/features/map/mapLayout";
import type { GraphView } from "@/generated/contracts";

/**
 * The map's edges, and the filter that makes them worth drawing.
 *
 * Drawing every import over the packed map is possible and mostly says nothing:
 * the pack puts a file beside the files it imports, so the great majority of
 * edges are twenty pixels long and vanish into their own folder. Measured on
 * a private monorepo, 2,589 of 2,710 edges never leave their package. What is left --
 * 121 of them -- is the repo's actual wiring, and at that density the curves
 * are countable.
 *
 * So the package rule is not a filter, it is the EMPHASIS. Every edge is
 * drawn; the ones that stay inside their package are a flat ground with no
 * colour and no density, and the ones that leave carry the cluster ink on top
 * of it. Hiding the other 2,589 made a map that looked wired only where the
 * reader happened to be pointing, which is a claim about the cursor rather
 * than about the repo.
 *
 * The emphasis inverts for one circle at a time, the one under the cursor or
 * left behind by a click. The package rule is right about the repo and wrong
 * about a file: a file's neighbours inside its own folder are most of what it
 * does, and they are exactly what the rule pushes into the ground. So the
 * subject takes every edge in and out of itself, crossing or not, at full ink
 * while everything else goes flat. See `buildFocus`.
 *
 * Bundling is Holten's: an edge is routed up the folder tree to the lowest
 * common ancestor and back down, then pulled part-way toward its own chord.
 * Sibling edges going the same way fuse into a trunk, which is what turns two
 * hundred separate crossings into a handful of readable flows.
 */

/**
 * How far an edge is pulled toward a straight line. 1 follows the folder tree
 * exactly and knots at every shared ancestor; 0 is the straight-line drawing
 * this filter exists to improve on. 0.9 keeps the trunks fused while leaving
 * each end aimed at its own dot.
 */
const STRAIGHTEN = 0.9;

/** Points sampled per spline segment. Twelve is smooth at any zoom this map reaches. */
const STEPS = 12;

/**
 * A directory holding nearly the whole repo is a wrapper, not a package. This
 * is the one number in the package rule, and it is what makes langchain's
 * `libs/` transparent (1,761 of 1,766 files) while leaving a monorepo's
 * `packages/` (476 of 995) as a package in its own right.
 */
const WRAPPER_SHARE = 0.9;

/**
 * Screen pixels between an arrowhead's tip and the circle it points at, and
 * the extra radius a collapsed folder is drawn with. Both are screen-space,
 * because a head is drawn at a constant size whatever the zoom -- so they are
 * divided by the camera scale to reach layout units, the way every width in
 * the renderer already is.
 */
const HEAD_GAP = 2;
const RING = 3.2;

/**
 * The arrowhead's length, in screen pixels. Long enough to read an angle off at
 * a glance, short enough that a bundle between two adjacent dots is still
 * mostly curve. Exported because the renderer draws it and this module decides
 * where it goes, and both answers have to come from one number.
 */
export const HEAD_LENGTH = 7;

/**
 * The smallest circle worth pointing at, as a screen radius.
 *
 * A head is drawn at a constant size, so on a dot smaller than the head is
 * long it stops being an arrow aimed at something and becomes a marker with a
 * speck attached -- measured on langchain's `text-splitters`, whose files are
 * eight-pixel dots at fit. Below this the direction goes unsaid, which the
 * flow colour and the chip still cover.
 */
const HEAD_MIN_TARGET = HEAD_LENGTH;

export interface Strand {
  ink: string;
  /** Whether this bundle carries any edge that leaves its package. */
  crossing: boolean;
  path: Path2D;
  /** The two anchor centres, in layout units. See `buildStrands` on why. */
  from: [number, number];
  to: [number, number];
}

/** Which way the traffic runs, relative to the circle under the cursor. */
export type Flow = "out" | "in" | "both";

/**
 * One drawn arrowhead: the tip, and the unit vector it points along.
 *
 * Resolved here rather than at draw time because it is geometry -- it depends
 * on the curve and on which circle the camera is showing, both of which this
 * module already knows and the renderer would have to be told. The renderer
 * gets four numbers and a fill.
 */
export interface Head {
  x: number;
  y: number;
  dx: number;
  dy: number;
}

export interface FocusStrand {
  flow: Flow;
  path: Path2D;
  /**
   * One head per direction the bundle carries, at the IMPORTER. A bundle that
   * runs both ways gets two, which is the case the flow colour handles worst:
   * `both` is a third hue to look up, where two arrows facing away from each
   * other need nothing remembered.
   */
  heads: Head[];
}

export interface Focus {
  strands: FocusStrand[];
  /**
   * EDGE counts, not strand counts. Bundling is what makes the drawing
   * readable and it is also what stops it being countable: one curve between
   * two collapsed folders can stand for nine imports, so the number has to be
   * said rather than left to be counted off the picture.
   */
  incoming: number;
  outgoing: number;
}

/** What "a package" turned out to mean on this repo. Said out loud in the stats. */
export interface Packages {
  count: number;
  /** The wrapper the packages sit inside, or "" when they are the top level. */
  inside: string;
}

/** What the tab is drawing, for the stats line. */
export interface EdgeSummary {
  packages: Packages;
  /** Edges that leave a package: what is emphasised, out of the view's total. */
  crossing: number;
}

export interface EdgeIndex {
  /** Every circle by path, and the chain from it up to the root. */
  chains: Map<string, MapCircle[]>;
  /** Every edge, with the ink of its source and whether it leaves its package. */
  edges: { source: string; target: string; ink: string; crossing: boolean }[];
  /** How many of them leave. Said in the stats line rather than drawn. */
  crossings: number;
  /**
   * The resolved package rule, for the reader rather than for the drawing.
   * Nothing on screen otherwise says whether `partners/openai` and
   * `partners/anthropic` count as one package or two, and the answer decides
   * which edges the tab is refusing to draw.
   */
  packages: Packages;
  /**
   * EVERY edge, from both ends. This is the half the package filter throws
   * away, kept because the hover exemption is the one reader that wants it.
   */
  touching: Map<string, { other: string; out: boolean }[]>;
}

/**
 * The depth at which this repo's packages sit.
 *
 * Descend from the root for as long as one child holds nearly everything. A
 * monorepo that puts every package under `libs/` would otherwise report a
 * single package and no crossings at all, which is true of the path strings and
 * false about the repo.
 */
function packageDepth(root: MapCircle): { depth: number; packages: Packages } {
  let node = root;
  let depth = 0;
  while (node.children.length > 0) {
    const wrapper = node.children.find(
      (child) => child.children.length > 0 && child.files >= node.files * WRAPPER_SHARE,
    );
    if (!wrapper) break;
    node = wrapper;
    depth += 1;
  }
  // The packages ARE the children of wherever the descent stopped, so there is
  // nothing to count separately.
  return { depth: depth + 1, packages: { count: node.children.length, inside: node.path } };
}

function packageOf(path: string, depth: number): string {
  return path.split("/").slice(0, depth).join("/");
}

/**
 * Everything that depends on the layout but not on the camera. Rebuilt when the
 * view or the sizing changes, which is also when the packing is rebuilt.
 */
export function buildEdgeIndex(root: MapCircle, view: GraphView): EdgeIndex {
  // Every chain, rather than the endpoints' chains on demand. The hover
  // exemption can ask about any circle in the repo, so there is no subset to
  // be lazy about, and each one is its parent's with the node on the front.
  const chains = new Map<string, MapCircle[]>();
  const walk = (circle: MapCircle, above: MapCircle[]) => {
    const chain = [circle, ...above];
    chains.set(circle.path, chain);
    circle.children.forEach((child) => walk(child, chain));
  };
  walk(root, []);

  const { depth, packages } = packageDepth(root);
  const edges: EdgeIndex["edges"] = [];
  const touching: EdgeIndex["touching"] = new Map();
  let crossings = 0;
  const note = (from: string, other: string, out: boolean) => {
    const found = touching.get(from);
    if (found) found.push({ other, out });
    else touching.set(from, [{ other, out }]);
  };

  for (const edge of view.edges) {
    const from = chains.get(edge.source);
    const to = chains.get(edge.target);
    // A path in the edge list that is not in the node list is the backend's
    // filters disagreeing with themselves; drop it rather than draw a curve
    // from nowhere, and let the visible-edge count in the stats say so.
    if (!from || !to) continue;
    note(edge.source, edge.target, true);
    note(edge.target, edge.source, false);
    const crossing = packageOf(edge.source, depth) !== packageOf(edge.target, depth);
    if (crossing) crossings += 1;
    edges.push({ source: edge.source, target: edge.target, ink: from[0]!.ink, crossing });
  }
  return { chains, crossings, edges, packages, touching };
}

/**
 * The circle an edge end actually lands on.
 *
 * Walk up from the file to the outermost ancestor the camera collapses into a
 * single dot. Past that the file is not drawn at all, so an edge to it would
 * end in empty ground -- which reads as a bug in the layout rather than as a
 * zoom level. Collapse is monotonic going up, because a parent is always
 * larger, so the last collapsed circle before the first open one is the one on
 * screen.
 */
function anchor(chain: MapCircle[], k: number): MapCircle {
  let found = chain[0]!;
  for (const node of chain) {
    if (node.depth === 0) break;
    if (node.r * k < COLLAPSE) found = node;
  }
  return found;
}

/** Control points: the folder circles the edge passes through, up then down. */
function controls(from: MapCircle[], to: MapCircle[]): MapCircle[] {
  const ancestors = new Set(to.map((node) => node.path));
  const head: MapCircle[] = [];
  for (const node of from) {
    head.push(node);
    if (ancestors.has(node.path)) break;
  }
  const meeting = head[head.length - 1]!;
  const tail: MapCircle[] = [];
  for (const node of to) {
    if (node.path === meeting.path) break;
    tail.push(node);
  }
  tail.reverse();
  return [...head, ...tail];
}

/**
 * Geometry for one camera scale.
 *
 * Every edge, bundled, each strand knowing whether it carries a crossing. The
 * renderer draws them twice: once flat as the ground, and once in cluster ink
 * for the ones that leave a package.
 *
 * Cached by the caller until the scale changes, because an edge ends on the
 * circle the camera SHOWS and that only changes when a zoom opens a folder --
 * so a pan re-uses this and only a zoom pays for it.
 *
 * Each strand carries its two endpoints so the renderer can drop the ones that
 * merely cross the pane. At a deep zoom the chord of a bundle whose ends are
 * both off screen is a diagonal line through everything, and a dozen of them
 * are a hatch over the dots that says nothing about what the reader is looking
 * at. Keeping only the strands that TOUCH something visible turns the same
 * drawing into "what connects to what is in front of me".
 */
export function buildStrands(index: EdgeIndex, k: number): Strand[] {
  // Fold to the pair of circles the camera actually shows. At fit, dozens of
  // file edges land on the same two folder dots, and drawing each one is how a
  // bundle turns into a blob. This is also what makes drawing ALL of them
  // affordable: one monorepo's 2,710 edges are a few hundred distinct pairs at
  // fit, because most of them start and end inside one collapsed folder and
  // fold away entirely.
  const bundles = new Map<
    string,
    { from: MapCircle[]; to: MapCircle[]; ink: string; crossing: boolean }
  >();
  for (const edge of index.edges) {
    const fromChain = index.chains.get(edge.source)!;
    const toChain = index.chains.get(edge.target)!;
    const a = anchor(fromChain, k);
    const b = anchor(toChain, k);
    if (a.path === b.path) continue;
    const key = `${a.path} -> ${b.path}`;
    const found = bundles.get(key);
    if (found) {
      // One crossing edge is enough to raise the bundle out of the ground:
      // the ground is what says "nothing here leaves", so a bundle that
      // carries a crossing has to be readable even if it also carries fifty
      // that do not.
      if (edge.crossing) found.crossing = true;
      continue;
    }
    bundles.set(key, {
      from: fromChain.slice(fromChain.indexOf(a)),
      to: toChain.slice(toChain.indexOf(b)),
      ink: edge.ink,
      crossing: edge.crossing,
    });
  }

  const strands: Strand[] = [];
  for (const bundle of bundles.values()) {
    const path = new Path2D();
    spline(path, straighten(controls(bundle.from, bundle.to)));
    const a = bundle.from[0]!;
    const b = bundle.to[0]!;
    strands.push({
      ink: bundle.ink,
      crossing: bundle.crossing,
      path,
      from: [a.x, a.y],
      to: [b.x, b.y],
    });
  }
  return strands;
}

/**
 * One circle's own edges, with the package filter lifted.
 *
 * The overview draws 121 of one monorepo's 2,710 edges and is right to. Point at
 * a single file and that rule inverts: the twelve imports it makes to its own
 * neighbours are the answer to "what is this file", and every one of them was
 * filtered out. So this takes the circle under the cursor and draws everything
 * that touches it either way.
 *
 * A FOLDER answers the same question one level up, which matters because at
 * fit almost nothing under the cursor is a file -- the pack collapses a folder
 * too small to open into one dot, and that dot is what a reader points at. Its
 * edges are the ones with exactly ONE end inside it. Edges wholly inside are
 * left out on purpose: they are what the folder is made of rather than what it
 * is connected to, and at a collapse they would be curves from a dot to
 * itself anyway.
 *
 * Direction is what this layer exists to say, because it is the thing position
 * cannot: the pack puts an importer and its import in the same place whichever
 * way round they are. It is said with an ARROW, pointing at the IMPORTER --
 * what the code does, `core` flowing into the modules that read it, rather
 * than the dependency notation's claim about who owes what.
 *
 * That is the reverse of the usual dependency arrow, for two reasons. An arrow
 * arriving at a circle then means what a reader expects it to mean, "this
 * comes into me", instead of its opposite. And it puts the crowded end where
 * the counts are bounded: a file can be imported by anything, but it can only
 * import what somebody typed into it. See the doc for the numbers.
 *
 * Colour says direction too -- warm for what the subject pulls in, cool for
 * who pulls from it -- but a colour is a legend to look up rather than a
 * direction to see, and it is stated relative to the subject, so the same
 * curve changes colour when the cursor moves. The arrow is the answer and the
 * hue is reinforcement.
 */
export function buildFocus(index: EdgeIndex, circle: MapCircle, k: number): Focus {
  const inside = new Set<string>();
  const collect = (node: MapCircle) => {
    if (node.isFile) inside.add(node.path);
    else node.children.forEach(collect);
  };
  collect(circle);

  const bundles = new Map<string, { from: MapCircle[]; to: MapCircle[]; out: boolean; into: boolean }>();
  let incoming = 0;
  let outgoing = 0;
  for (const path of inside) {
    const here = index.chains.get(path);
    if (!here) continue;
    for (const edge of index.touching.get(path) ?? []) {
      if (inside.has(edge.other)) continue;
      const there = index.chains.get(edge.other);
      if (!there) continue;
      if (edge.out) outgoing += 1;
      else incoming += 1;
      const a = anchor(here, k);
      const b = anchor(there, k);
      if (a.path === b.path) continue;
      const key = `${a.path} -> ${b.path}`;
      const found = bundles.get(key);
      if (found) {
        if (edge.out) found.out = true;
        else found.into = true;
        continue;
      }
      bundles.set(key, {
        from: here.slice(here.indexOf(a)),
        to: there.slice(there.indexOf(b)),
        out: edge.out,
        into: !edge.out,
      });
    }
  }

  const strands: FocusStrand[] = [];
  for (const bundle of bundles.values()) {
    const path = new Path2D();
    const traced = spline(path, straighten(controls(bundle.from, bundle.to)));
    const flow: Flow = bundle.out && bundle.into ? "both" : bundle.out ? "out" : "in";
    // The head goes at the IMPORTER, which is the end the code arrives at. The
    // curve runs subject-side first, so that is the near end for what the
    // subject imports and the far end for whoever imports it.
    const heads: Head[] = [];
    if (bundle.out) {
      const near = head(traced, bundle.from[0]!, k, false);
      if (near) heads.push(near);
    }
    if (bundle.into) {
      const far = head(traced, bundle.to[0]!, k, true);
      if (far) heads.push(far);
    }
    strands.push({ flow, path, heads });
  }
  return { strands, incoming, outgoing };
}

/** Pull the control points toward the chord, so a bundle stays aimed at its ends. */
function straighten(points: MapCircle[]): [number, number][] {
  const last = points.length - 1;
  if (last < 2) return points.map((node) => [node.x, node.y]);
  const [x0, y0] = [points[0]!.x, points[0]!.y];
  const [x1, y1] = [points[last]!.x, points[last]!.y];
  return points.map((node, i) => {
    const t = i / last;
    return [
      STRAIGHTEN * node.x + (1 - STRAIGHTEN) * (x0 + t * (x1 - x0)),
      STRAIGHTEN * node.y + (1 - STRAIGHTEN) * (y0 + t * (y1 - y0)),
    ];
  });
}

/**
 * Clamped uniform cubic B-spline, appended as one subpath, and its samples
 * returned.
 *
 * The samples are the only record of where the curve actually goes: a `Path2D`
 * is opaque once written, so an arrowhead that wants to sit where the curve
 * CROSSES a circle has no way to ask. They are computed here either way, so
 * returning them costs an array the caller is free to drop -- `buildStrands`
 * does.
 */
function spline(path: Path2D, points: [number, number][]): [number, number][] {
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const control = [first, first, ...points, last, last];
  path.moveTo(first[0], first[1]);
  const traced: [number, number][] = [first];
  for (let s = 0; s + 3 < control.length; s += 1) {
    const [p0, p1, p2, p3] = [control[s]!, control[s + 1]!, control[s + 2]!, control[s + 3]!];
    for (let i = 1; i <= STEPS; i += 1) {
      const t = i / STEPS;
      const t2 = t * t;
      const t3 = t2 * t;
      const b0 = (-t3 + 3 * t2 - 3 * t + 1) / 6;
      const b1 = (3 * t3 - 6 * t2 + 4) / 6;
      const b2 = (-3 * t3 + 3 * t2 + 3 * t + 1) / 6;
      const b3 = t3 / 6;
      const x = b0 * p0[0] + b1 * p1[0] + b2 * p2[0] + b3 * p3[0];
      const y = b0 * p0[1] + b1 * p1[1] + b2 * p2[1] + b3 * p3[1];
      path.lineTo(x, y);
      traced.push([x, y]);
    }
  }
  return traced;
}

/**
 * Where a head goes on one end of a curve.
 *
 * The tip sits just outside the circle's DRAWN edge, which is not its radius:
 * `MapCanvas` fills a collapsed folder at `r` and then rings it at `r + 2.6`,
 * so a head clamped to `r` lands inside the ring it is pointing at. A file has
 * no ring and gets the gap alone.
 *
 * A head is also skipped on a circle too small to be pointed at. See
 * `HEAD_MIN_TARGET`.
 *
 * Walking the samples rather than measuring along the chord is the whole point
 * of doing this here. A bundled strand is routed up to the lowest common
 * ancestor and back down, so it arrives at an angle the straight line between
 * the two circles knows nothing about, and a head aimed along that line points
 * at a place the curve never came from.
 */
function head(
  traced: [number, number][],
  target: MapCircle,
  k: number,
  atEnd: boolean,
): Head | null {
  if (target.r * k < HEAD_MIN_TARGET) return null;
  const clearance = target.r + (target.children.length > 0 ? RING : 0) / k + HEAD_GAP / k;
  const step = atEnd ? -1 : 1;
  let found = -1;
  for (let i = atEnd ? traced.length - 1 : 0; i >= 0 && i < traced.length; i += step) {
    const [x, y] = traced[i]!;
    if (Math.hypot(x - target.x, y - target.y) >= clearance) {
      found = i;
      break;
    }
  }
  // The curve never leaves the circle it ends on, so there is nowhere to put a
  // head that is not on top of the dot it points at. Draw none.
  const inward = found - step;
  if (found < 0 || inward < 0 || inward >= traced.length) return null;
  const [x, y] = traced[found]!;
  const [ix, iy] = traced[inward]!;
  const length = Math.hypot(ix - x, iy - y) || 1;
  return { x, y, dx: (ix - x) / length, dy: (iy - y) / length };
}
