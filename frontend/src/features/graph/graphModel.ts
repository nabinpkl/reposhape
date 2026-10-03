import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";

import type { GraphView } from "@/generated/contracts";

/** Measured off graphify's rendered page. See docs/graph-rendering.md. */
export type ColorScheme = "dark" | "light";

/**
 * Everything about the canvas that is colour, per scheme. The chrome follows
 * CSS tokens; the canvas cannot, because its colours are pre-composited data
 * (edge ink is mixed against the ground by hand -- sigma's programs did not
 * visibly honour an rgba() alpha here). So a scheme change repaints data
 * colours in place (applySchemeColors) instead of rebuilding: positions never
 * move, the camera never resets, and no fetch fires.
 *
 * The two schemes are symmetric in derivation, not in values. Dark lifts discs
 * to full value because the palette arrives muted; light keeps the raw Tableau
 * 10, which was designed on white. Selection is the value no cluster can
 * claim on that ground: white on dark, near-black on light. Dimming moves
 * toward the canvas on both, never toward white, never toward black.
 */
export const SCHEMES = {
  dark: {
    ground: "#0f0f1a",
    dimNode: "#1e1e2b",
    selected: "#ffffff",
    label: "#c9c9d8",
    labelFocused: "#ffffff",
    hoverGround: "#141422",
    isolated: "#ababaf",
    fallback: "#5c5c72",
    runtimeLink: "#e0a93e",
  },
  light: {
    ground: "#eef0f4",
    dimNode: "#dde1e9",
    selected: "#11131a",
    label: "#565b6b",
    labelFocused: "#11131a",
    hoverGround: "#ffffff",
    isolated: "#68707e",
    fallback: "#5c5c72",
    runtimeLink: "#a8700a",
  },
} as const satisfies Record<string, {
  ground: string;
  dimNode: string;
  selected: string;
  label: string;
  labelFocused: string;
  hoverGround: string;
  isolated: string;
  fallback: string;
  /** One hue for every runtime link (ADR-0009): it is a kind, not a cluster. */
  runtimeLink: string;
}>;

export const RENDER = {
  /**
   * The single most load-bearing value here. At 0.35 on a near-black ground the
   * edges stop being objects you read one by one and become texture, so what
   * you see is cluster shape and the few bridges between clusters. At 1.0 the
   * same graph is a grey mat with dots on it.
   */
  edgeAlpha: 0.35,
  /**
   * The ink an edge carries is alpha times thickness times arrowheads, and the
   * first attempt here kept graphify's 0.35 while forgetting the other two.
   * 2,680 arrow-typed edges at full thickness turned the graph into a white
   * disc. Base edges are thin, un-arrowed and this dim; direction and weight
   * come back only for the edges of a focused node, where there are a dozen.
   */
  /**
   * Edge ink follows graphify's `inherit: "from"`: each edge carries its
   * SOURCE file's cluster colour. Pre-composited against the ground rather
   * than expressed as alpha -- sigma's line program did not visibly honour
   * an `rgba()` alpha here, and the ground is a known constant, so mixing by
   * hand is deterministic. This replaces the uniform `#2b2b3a` (which was
   * `#8a8aa8` at 0.22 over the ground): 0.35 ground keeps edges readable --
   * brighter than the 0.55 that came before, still short of a grey mat -- and
   * type-only edges sit further back at 0.55 so the filter's distinction is
   * visible without asking. `ground` must match `--color-canvas`.
   */
  ground: SCHEMES.dark.ground,
  edgeGroundMix: 0.35,
  edgeGroundMixTypeOnly: 0.55,
  /**
   * Edge thickness in pixels, and the reason this drawing kept reading as
   * less data than graphify's beside it.
   *
   * Measured 2026-09-14 on the split view, both panes on the same 989 nodes
   * and 2,686 edges, normalised to one scale: at 0.35 our edges carried 1.68
   * rendered pixels each against graphify's 9.14, so edges were 6% of our ink
   * and 48% of theirs. graphify's exporter writes `width: 2, opacity: 0.7` on
   * every EXTRACTED edge, which is every edge our file-level graph hands it.
   *
   * The eye reads a graph's quantity off the edge fabric, not off the discs,
   * so 94% of the ink on dots read as a sparse scatter no matter how the
   * layout was tuned. That is why the 2026-09-12 global simulation did not
   * settle it: it moved the dots closer and left the ink alone. At 1.2 the
   * drawing fills 16.7% of its own extent against graphify's 18.1%, up from
   * 11.2%, and the clusters read as bodies rather than as constellations.
   */
  edgeSize: 1.2,
  /**
   * Discs, in pixels at rest zoom. These are SCREEN pixels and do not shrink
   * as sigma fits more nodes into the frame, while vis-network's radii are in
   * graph units and do, so the same pair of numbers reads heavier here the
   * bigger the repo gets. Measured against graphify's file-level page at
   * matched scale, 3-11 put 2.1x their node ink on screen while the edges
   * carried a fifth of theirs; 2.5-8 is what balances the two. Degree still
   * enters through a square root, so hubs keep their emphasis. Keep
   * labelRenderedSizeThreshold in GraphCanvas at roughly half of maxNodeSize
   * when this moves.
   */
  minNodeSize: 2.5,
  maxNodeSize: 8,
  /**
   * There is no cluster-spread constant here any more, and its absence is the
   * decision. A post-simulation radial push of each Louvain cluster away from
   * the barycentre bought boundary air and cost the thing the air was for:
   * measured 2026-09-14 against graphify's files pane, it broke the drawing
   * into 31 separate blobs with the largest holding 58% of the occupied grid
   * cells, and no amount of edge weight makes a field of islands read as a
   * body of work. Removed, the same layout is one continent at 96%. Clusters
   * are told apart by colour, which never needed the gap.
   */
  /** Dimming on this ground means moving toward the canvas, never toward white. */
  dimNode: SCHEMES.dark.dimNode,
  dimEdge: "rgba(42, 42, 78, 0.22)",
  /**
   * Isolates carry no cluster identity -- the backend groups every file with
   * no edge into one trailing "(no imports)" bucket -- so they cannot take a
   * cluster colour without inventing structure. But the bucket's `#3a3a4e`
   * dissolved into the ground and the halo read as missing dots next to
   * graphify's vivid outer ring. Light neutral instead: visible at 3px against
   * the ground while claiming no cluster.
   */
  isolatedColor: SCHEMES.dark.isolated,
  /** Selection is white because white is the one value no cluster can claim. */
  selected: SCHEMES.dark.selected,
} as const;

export interface NodeAttributes {
  label: string;
  x: number;
  y: number;
  size: number;
  color: string;
  cluster: number;
  inDegree: number;
  outDegree: number;
  lines: number;
  fullPath: string;
}

export interface EdgeAttributes {
  size: number;
  color: string;
  typeOnly: boolean;
  /** A runtime link drawn over the import graph, never laid out on. */
  runtime: boolean;
  type?: string;
}

export type ImportGraph = Graph<NodeAttributes, EdgeAttributes>;

/** The last two segments. A full path as a label is unreadable at any zoom. */
export function shortLabel(path: string): string {
  const segments = path.split("/");
  return segments.slice(-2).join("/");
}

/** Push a hex to full value (brightness 100%): hue and saturation stay, the
 * strongest channel hits 255. Cluster colours arrive muted; at full value
 * they read vivid without collapsing into white. */
export function fullValue(hex: string): string {
  let h = hex.startsWith("#") ? hex.slice(1) : hex;
  if (h.length === 3) h = h.slice(0, 1).repeat(2) + h.slice(1, 2).repeat(2) + h.slice(2, 3).repeat(2);
  const channels = [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
  const peak = Math.max(...channels);
  if (peak === 0) return hex;
  const scale = 255 / peak;
  const out = (n: number) => Math.min(255, Math.round(n * scale)).toString(16).padStart(2, "0");
  return `#${out(channels[0]!)}${out(channels[1]!)}${out(channels[2]!)}`;
}

/** Mix a foreground hex toward a ground hex; result is `#rrggbb`. */
export function mixHex(foreground: string, ground: string, groundFraction: number): string {
  const channels = (hex: string): [number, number, number] => {
    let h = hex.startsWith("#") ? hex.slice(1) : hex;
    if (h.length === 3) h = h.slice(0, 1).repeat(2) + h.slice(1, 2).repeat(2) + h.slice(2, 3).repeat(2);
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    ];
  };
  const [fr, fg, fb] = channels(foreground);
  const [gr, gg, gb] = channels(ground);
  const mix = (f: number, g: number) =>
    Math.max(0, Math.min(255, Math.round(f + (g - f) * groundFraction)));
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${hex(mix(fr, gr))}${hex(mix(fg, gg))}${hex(mix(fb, gb))}`;
}

/** A cluster's disc ink on a scheme. Dark lifts the muted palette to full
 * value (hue and saturation stay, so clusters keep their identity, but
 * nothing renders muted); light keeps raw Tableau 10, which was designed on
 * white. */
export function discColor(clusterHex: string, scheme: ColorScheme): string {
  return scheme === "dark" ? fullValue(clusterHex) : clusterHex;
}

/** graphify's inherit-from-source, pre-composited against the scheme's
 * ground. `ground` must match `--color-canvas` of the same scheme. */
export function edgeColor(
  sourceClusterHex: string,
  typeOnly: boolean,
  scheme: ColorScheme,
): string {
  return mixHex(
    discColor(sourceClusterHex, scheme),
    SCHEMES[scheme].ground,
    typeOnly ? RENDER.edgeGroundMixTypeOnly : RENDER.edgeGroundMix,
  );
}

/**
 * Repaint data colours for a scheme change. Positions, camera and fetches are
 * untouched -- the layout is never rebuilt, so toggling the theme cannot
 * reshuffle the graph. The reducers in GraphCanvas read these base colours
 * through `...data`, so a refresh after this is the whole update.
 */
export function applySchemeColors(
  graph: ImportGraph,
  view: GraphView,
  scheme: ColorScheme,
): void {
  const colors = SCHEMES[scheme];
  const colorOf = new Map(view.clusters.map((cluster) => [cluster.id, cluster.color]));
  const clusterOf = new Map(view.nodes.map((node) => [node.path, node.cluster]));
  graph.forEachNode((node, attributes) => {
    const degree = attributes.inDegree + attributes.outDegree;
    graph.setNodeAttribute(
      node,
      "color",
      degree === 0
        ? discColor(colors.isolated, scheme)
        : discColor(colorOf.get(attributes.cluster) ?? colors.fallback, scheme),
    );
  });
  graph.forEachEdge((edge, attributes, source) => {
    if (attributes.runtime) {
      graph.setEdgeAttribute(edge, "color", colors.runtimeLink);
      return;
    }
    const sourceCluster = clusterOf.get(source);
    const sourceColor =
      (sourceCluster !== undefined ? colorOf.get(sourceCluster) : undefined) ??
      colors.fallback;
    graph.setEdgeAttribute(edge, "color", edgeColor(sourceColor, attributes.typeOnly, scheme));
  });
}

export function buildGraph(view: GraphView, scheme: ColorScheme = "dark"): ImportGraph {
  const graph: ImportGraph = new Graph({ type: "directed", multi: false });
  const colors = SCHEMES[scheme];
  const colorOf = new Map(view.clusters.map((cluster) => [cluster.id, cluster.color]));
  const clusterOf = new Map(view.nodes.map((node) => [node.path, node.cluster]));

  let maxDegree = 1;
  for (const node of view.nodes) {
    maxDegree = Math.max(maxDegree, node.in_degree + node.out_degree);
  }

  // Random initial positions: ForceAtlas2 has no repulsion to act on when every
  // node starts at the origin, and the layout comes out as a single dot.
  for (const node of view.nodes) {
    const degree = node.in_degree + node.out_degree;
    graph.addNode(node.path, {
      label: shortLabel(node.path),
      x: Math.random(),
      y: Math.random(),
      size:
        RENDER.minNodeSize +
        (RENDER.maxNodeSize - RENDER.minNodeSize) * Math.sqrt(degree / maxDegree),
      // Degree zero means the trailing "(no imports)" bucket, whose dim grey
      // vanishes on the ground: the halo needs the light neutral instead.
      // Every disc goes through full value: hue and saturation stay, so
      // clusters keep their identity, but nothing renders muted.
      color:
        degree === 0
          ? discColor(colors.isolated, scheme)
          : discColor(colorOf.get(node.cluster) ?? colors.fallback, scheme),
      cluster: node.cluster,
      inDegree: node.in_degree,
      outDegree: node.out_degree,
      lines: node.lines,
      fullPath: node.path,
    });
  }

  for (const edge of view.edges) {
    if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) continue;
    if (graph.hasEdge(edge.source, edge.target)) continue;
    // graphify's inherit-from-source: the edge carries its source file's
    // cluster colour, dimmed toward the ground so it stays readable without
    // becoming a mat. Same vivid hue as the source disc.
    const sourceCluster = clusterOf.get(edge.source);
    const sourceColor =
      (sourceCluster !== undefined ? colorOf.get(sourceCluster) : undefined) ??
      colors.fallback;
    graph.addDirectedEdge(edge.source, edge.target, {
      size: RENDER.edgeSize,
      color: edgeColor(sourceColor, edge.type_only, scheme),
      typeOnly: edge.type_only,
      runtime: false,
    });
  }

  return graph;
}

/**
 * Runtime links, added once the layout has run so they can never move it
 * (ADR-0009: clustering and position are the import graph's). A pair already
 * joined by an import in either direction gets nothing: it is connected, and
 * a dash over a solid edge only thickens it. Hidden until the reader turns the
 * layer on, which the edge reducer decides.
 */
export function addRuntimeLinks(
  graph: ImportGraph,
  view: GraphView,
  scheme: ColorScheme = "dark",
): void {
  for (const link of view.links) {
    const { source, target } = link;
    if (source === target || !graph.hasNode(source) || !graph.hasNode(target)) continue;
    if (graph.hasEdge(source, target) || graph.hasEdge(target, source)) continue;
    graph.addDirectedEdge(source, target, {
      size: RENDER.edgeSize * 1.8,
      color: SCHEMES[scheme].runtimeLink,
      typeOnly: false,
      runtime: true,
      type: "dashed",
    });
  }
}

/**
 * One ForceAtlas2 simulation over everything connected, then a halo of the
 * isolates and 2-3 node satellites around the drawing.
 *
 * This used to lay each connected component out on its own and pack the
 * results by file count, which separated clusters well (silhouette 0.387)
 * but capped every component at its packing radius: no simulation tuning
 * could ever make the main cluster bigger on screen, and hub-centred
 * components froze mid-stretch into fans instead of balls. The table that
 * chose packing is kept below as the record; the row that matters now is
 * the second one -- one simulation scores higher separation than packing
 * ever did, and its failure was fill, not shape.
 *
 * Fill failed because isolates were IN the simulation: repulsion alone threw
 * 161 single files into an enormous ring, the camera fitted the ring, and
 * the structure drew as pinheads (fill 0.011). They are out of the simulation
 * now, gridded beside the drawing at its own dot spacing, which is also what
 * keeps the ring from coming back. Small satellite components can still drift
 * wider than packing would ever let them; gravity holds them, and that is the
 * accepted trade for a spread the simulation decides rather than a rule.
 *
 * A graph that keeps simulating never feels settled and every drag disturbs the
 * whole picture, so this runs a fixed number of iterations and never restarts.
 *
 * The shape of the problem, measured rather than assumed: one monorepo's 989
 * visible files are **174 connected components**, and the largest holds 457 of
 * them. ForceAtlas2 applies no attraction between components, so running it
 * over all of them at once is 173 things being flung outward with nothing but
 * gravity holding them in. The first version of this file did exactly that and
 * then reached for `strongGravityMode` to stop the escape, which worked and
 * cost the thing the layout was for: a gravity strong enough to hold unrelated
 * components in frame is strong enough to crush the clusters inside the big one
 * into a single ball.
 *
 * The number that says so is the mean silhouette of the Louvain labels over the
 * drawn 2D positions: +1 means every file sits nearer its own cluster than any
 * other, 0 means the clusters are visually indistinguishable, negative means
 * they are interleaved. Measured on 989 files and 2,686 edges, with fill being
 * the share of a 100x100 grid over the frame that carries any node at all:
 *
 *   one simulation, strongGravity g1 sr1 (was shipped)   silhouette -0.074
 *   one simulation, plain gravity 1                      silhouette  0.526, fill 0.011
 *   one simulation, linLog 3000 iterations               silhouette  0.483, fill 0.036
 *   per component, packed, plain gravity 1               silhouette  0.387, fill 0.066
 *
 * The shipped row is negative: the average file really was closer to some other
 * cluster than to its own, which is what "the clusters are not separated" looks
 * like as a number. Rows two and three separate better than anything here but
 * score a tenth of the fill, and that is not a quibble about density: with the
 * camera fitted to the extent, a handful of escaped components set the frame
 * and everything else is drawn as pinheads in a void.
 *
  * The settings below are the plain ones the table's second row used, kept
  * because nothing beat them: inside the 457-node component, averaged over
  * five seeds, plain gravity 1 scores 0.23 at 600 iterations and gains nothing
  * from 1200 or 2500; linLog beats it only at 0.2 gravity and 2500
  * iterations, 0.276 for four times the work, with a seed spread (0.19 to 0.36)
  * wider than the gap it wins by. `outboundAttractionDistribution` scored worst
  * of everything tried, at or below zero.
  *
  * One thing this deliberately does NOT do: weight intra-cluster edges above the
  * ones that cross clusters. It scores highest of anything measured (0.906) and
  * it is circular, because it lays the graph out according to the answer the
  * graph is supposed to be showing you. A clustering that is wrong would still
  * draw as tidy separated balls.
  */
export function layout(graph: ImportGraph): void {
  if (graph.order === 0) return;

  const groups = componentsOf(graph);
  // Small satellite groups simulate badly -- nothing holds them relative to
  // the drawing, so they drift into voids -- and graphify parks its 2-3 node
  // disjoints in the outer with the isolates. They join the halo instead, each
  // group's members on adjacent slots so the pair or triple still reads as one
  // tiny group, keeping their real cluster colours and edges.
  const connected = groups.filter((group) => group.length > SATELLITE_MAX).flat();
  const satellites = groups
    .filter((group) => group.length > 1 && group.length <= SATELLITE_MAX)
    .map((group) => [...group].sort());
  const alone = groups.filter((group) => group.length === 1).flat();

  if (connected.length > 0) {
    // One simulation over everything with an edge in it. Cross-component
    // bridges and gravity arrange the components relative to each other, so
    // the main cluster lands central and spreads radially instead of taking
    // whatever slot a packing rule deals it.
    const whole = subgraphOf(graph, connected);
    forceAtlas2.assign(whole, {
      iterations: whole.order > 2000 ? 300 : 600,
      settings: {
        linLogMode: false,
        // Anti-collision runs as a local repulsion competing with the global
        // one doing the separating, and it reads node `size` as a radius in
        // layout units, which are not the units sizes are expressed in.
        adjustSizes: false,
        outboundAttractionDistribution: false,
        barnesHutOptimize: whole.order > 400,
        barnesHutTheta: 0.5,
        // Distance-proportional pull: far components feel real attraction
        // while near ones barely notice, which is the anti-escape shape a
        // flat gravity cannot give without crushing the clusters it holds.
        strongGravityMode: true,
        // Gravity is the only thing holding disconnected components in
        // frame. Uniform gravity was tried at 1, 3 and 8: nearer each time,
        // but still islands with voids between them.
        gravity: 1,
        // A notch above 1 so communities breathe a little further apart.
        // This scales all repulsion, inside clusters too, so it is air
        // everywhere rather than separation bought off cluster tightness.
        scalingRatio: 1.3,
        slowDown: 2,
        edgeWeightInfluence: 0,
      },
    });
    centreOnBarycentre(whole);
    whole.forEachNode((node, attributes) => {
      graph.setNodeAttribute(node, "x", attributes.x);
      graph.setNodeAttribute(node, "y", attributes.y);
    });
    packFanOuts(graph, connected);
  }

  // The isolates grid below is placed off the drawing's extent, which the
  // camera fits; with nothing simulated they would otherwise sit on their
  // random starting points inside the structure.
  let minX = 0;
  let maxX = 0;
  let minY = 0;
  let maxY = 0;
  for (const path of connected) {
    const attributes = graph.getNodeAttributes(path);
    minX = Math.min(minX, attributes.x);
    maxX = Math.max(maxX, attributes.x);
    minY = Math.min(minY, attributes.y);
    maxY = Math.max(maxY, attributes.y);
  }
  placeIsolated(
    graph,
    // Each group lands as one anchor, so satellite pairs and triples still
    // read as tiny groups; placement itself is random per group.
    [...satellites, ...[...alone].sort().map((node) => [node])],
    { minX, maxX, minY, maxY },
    typicalSpacing(graph, connected),
  );
}

/** Groups this size or smaller skip the simulation and join the halo. */
const SATELLITE_MAX = 3;

/** Weakly connected components, largest first. */
function componentsOf(graph: ImportGraph): string[][] {
  const seen = new Set<string>();
  const groups: string[][] = [];
  graph.forEachNode((node) => {
    if (seen.has(node)) return;
    const stack = [node];
    const group: string[] = [];
    seen.add(node);
    while (stack.length > 0) {
      const current = stack.pop()!;
      group.push(current);
      graph.forEachNeighbor(current, (next) => {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      });
    }
    groups.push(group);
  });
  return groups.sort((a, b) => b.length - a.length);
}

function subgraphOf(graph: ImportGraph, members: string[]): ImportGraph {
  const sub: ImportGraph = new Graph({ type: "directed" });
  for (const node of members) sub.addNode(node, { ...graph.getNodeAttributes(node) });
  graph.forEachEdge((_edge, attributes, source, target) => {
    if (sub.hasNode(source) && sub.hasNode(target) && !sub.hasEdge(source, target)) {
      sub.addDirectedEdge(source, target, attributes);
    }
  });
  return sub;
}

/** Move a component onto its own centre, and report the radius it needs. */
function centreOnBarycentre(component: ImportGraph): number {
  let cx = 0;
  let cy = 0;
  component.forEachNode((_node, attributes) => {
    cx += attributes.x;
    cy += attributes.y;
  });
  cx /= component.order;
  cy /= component.order;

  let radius = 0;
  component.forEachNode((node, attributes) => {
    const x = attributes.x - cx;
    const y = attributes.y - cy;
    component.setNodeAttribute(node, "x", x);
    component.setNodeAttribute(node, "y", y);
    radius = Math.max(radius, Math.hypot(x, y));
  });
  return radius || 1;
}

/**
 * Pull a hub's degree-1 leaves into a disc that FILLS, instead of a ring that
 * does not.
 *
 * ForceAtlas2 settles a leaf where its one edge's pull balances the repulsion
 * of every other leaf on the same hub, and with hundreds of them that balance
 * point is a shell. Measured 2026-09-14 on langchain, whose
 * `langchain_classic/_api/__init__.py` is imported by 818 files and nothing
 * else: the leaves sat in an annulus from radius 28 to 57, the inner 24% of
 * that disc was empty, and the leaves themselves were less than half the
 * density of the rest of the drawing (0.107 against 0.237 per unit squared).
 * The whole starburst took 25.9% of the drawing's extent to show one fact.
 *
 * So each leaf keeps the ANGLE the simulation gave it, which is where the
 * simulation found room, and only its radius is reassigned: rank the leaves
 * by how far out they landed and spread them over the disc as sqrt of rank,
 * which is the uniform-density curve and is why the result reads as a flower
 * head rather than as a ring. The disc is sized to hold them at the drawing's
 * own grain, floored at one median edge so a fan of four keeps ordinary edges
 * and is left alone.
 *
 * Two things make this safe where the deleted `clusterSpread` was not. It
 * only ever CONTRACTS -- a hub whose leaves already fit is skipped -- so it
 * can move nothing into anything. And the space it claims was measured empty
 * first: inside the target radius of 33 on that hub there were 818 of its own
 * leaves and zero other nodes.
 */
function packFanOuts(graph: ImportGraph, laid: string[]): void {
  const spacing = typicalSpacing(graph, laid);
  const edge = medianEdgeLength(graph);
  if (spacing <= 0 || edge <= 0) return;

  for (const hub of laid) {
    const leaves = graph.neighbors(hub).filter((node) => graph.degree(node) === 1);
    if (leaves.length < 2) continue;

    const centre = graph.getNodeAttributes(hub);
    const polar = leaves
      .map((node) => {
        const point = graph.getNodeAttributes(node);
        const dx = point.x - centre.x;
        const dy = point.y - centre.y;
        return { node, angle: Math.atan2(dy, dx), radius: Math.hypot(dx, dy) };
      })
      .sort((a, b) => a.radius - b.radius);

    const outer = polar[polar.length - 1]?.radius ?? 0;
    const packed = Math.sqrt(leaves.length / Math.PI) * spacing;
    const target = Math.max(packed, edge);
    if (target >= outer) continue;

    for (const [rank, leaf] of polar.entries()) {
      const radius = spacing + (target - spacing) * Math.sqrt((rank + 0.5) / polar.length);
      graph.setNodeAttribute(leaf.node, "x", centre.x + radius * Math.cos(leaf.angle));
      graph.setNodeAttribute(leaf.node, "y", centre.y + radius * Math.sin(leaf.angle));
    }
  }
}

/** How long an ordinary edge is in this drawing, in layout units. */
function medianEdgeLength(graph: ImportGraph): number {
  const lengths: number[] = [];
  graph.forEachEdge((_edge, _attributes, source, target) => {
    const a = graph.getNodeAttributes(source);
    const b = graph.getNodeAttributes(target);
    lengths.push(Math.hypot(a.x - b.x, a.y - b.y));
  });
  if (lengths.length === 0) return 0;
  lengths.sort((a, b) => a - b);
  return lengths[Math.floor(lengths.length / 2)] ?? 0;
}

/** The drawing's own grain: the median nearest-neighbour distance, sampled. */
function typicalSpacing(graph: ImportGraph, laid: string[]): number {
  if (laid.length < 2) return 0.05;
  const points = laid.map((node) => graph.getNodeAttributes(node));
  const stride = Math.ceil(points.length / 200);
  const nearest: number[] = [];
  for (let i = 0; i < points.length; i += stride) {
    const point = points[i];
    if (point === undefined) continue;
    let best = Infinity;
    for (const other of points) {
      if (other === point) continue;
      best = Math.min(best, Math.hypot(point.x - other.x, point.y - other.y));
    }
    if (Number.isFinite(best)) nearest.push(best);
  }
  nearest.sort((a, b) => a - b);
  return nearest[Math.floor(nearest.length / 2)] || 0.05;
}

/**
 * Everything outside the simulation, as a thin halo hugging the drawing:
 * files that import nothing and are imported by nothing, plus 2-3 node
 * satellite groups that simulate badly and read better here.
 *
 * They are still on screen and still clickable; they are just not pretending to
 * be positioned by anything. Left in the simulation the isolates have nothing
 * attracting them and repulsion alone throws them into an enormous ring, while
 * the satellites drift into voids with nothing holding them to the drawing.
 * Packed into a disc beside it, all of them claimed frame on one side; ringed
 * around it instead, they add a uniform margin in every direction and read as
 * a rounded edge over the clusters rather than a second object beside them.
 *
 * The halo is an elliptical band following the drawing's own bounds, not a
 * circle: a circle has to clear the corners, which leaves a void on every side
 * of a drawing wider than it is tall. Within the band every group lands at a
 * random angle and a depth drawn from an exponential falloff -- most settle
 * near the drawing, a few stray far -- so the outline wobbles upward and
 * downward instead of tracing one deliberate circle: the two versions before
 * this, a golden-angle spiral and then a uniform random band, both read as
 * exactly what they were next to graphify's randomish outer. The band is
 * about two and a half grains wide -- sparser than the drawing's own grain,
 * which is honest, since nothing positioned these files -- with area per file
 * still the budget the width is sized from.
 */
function placeIsolated(
  graph: ImportGraph,
  halo: string[][],
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
  step: number,
): void {
  const total = halo.reduce((count, group) => count + group.length, 0);
  if (total === 0) return;

  const { minX, maxX, minY, maxY } = bounds;
  const width = Math.max(maxX - minX, step);
  const height = Math.max(maxY - minY, step);
  const cx = minX + width / 2;
  const cy = minY + height / 2;
  // Inner ellipse clears the drawing's sides, not its corners: a circle around
  // these bounds would stand off by the half-diagonal everywhere.
  const margin = step * 2;
  const a = width / 2 + margin;
  const b = height / 2 + margin;
  // Same area per file as the square grid this replaced: a thin band's area is
  // roughly its perimeter times its thickness (Ramanujan's perimeter). The
  // band itself runs wider than that grain, so the scatter breathes.
  const perimeter =
    Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
  const band = ((total * step * step) / perimeter) * 2.5;
  const radiusAt = (angle: number): number => {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return (a * b) / Math.sqrt(b * b * cos * cos + a * a * sin * sin);
  };

  for (const group of halo) {
    const angle = Math.random() * Math.PI * 2;
    // Most settle near the drawing, a few drift far: an exponential falloff
    // instead of a uniform band, so the outline wobbles and strays reach up
    // and down rather than tracing one deliberate circle. Capped so a single
    // far dot cannot steal the camera fit.
    const depth = -Math.log(1 - Math.random()) * band * 0.8;
    const reach = radiusAt(angle) + Math.min(depth, band * 4);
    const ax = cx + reach * Math.cos(angle);
    const ay = cy + reach * Math.sin(angle);
    group.forEach((node, index) => {
      // Group members jitter around their shared anchor, so a pair or triple
      // lands as one tiny clump at a randomish spot in the band.
      const jx = index === 0 ? 0 : (Math.random() - 0.5) * step;
      const jy = index === 0 ? 0 : (Math.random() - 0.5) * step;
      graph.setNodeAttribute(node, "x", ax + jx);
      graph.setNodeAttribute(node, "y", ay + jy);
    });
  }
}
