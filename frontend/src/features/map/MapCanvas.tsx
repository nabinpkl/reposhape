"use client";

import { useTheme } from "next-themes";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { useFilters } from "@/features/filters/filterStore";
import { SCHEMES, mixHex, type ColorScheme } from "@/features/graph/graphModel";
import {
  HEAD_LENGTH,
  buildEdgeIndex,
  buildFocus,
  buildStrands,
  type EdgeSummary,
  type Flow,
  type Focus,
  type Strand,
} from "@/features/map/mapEdges";
import { COLLAPSE, MAP_SIZE, packView, type MapCircle, type Sizing } from "@/features/map/mapLayout";
import type { GraphView } from "@/generated/contracts";

/**
 * The map's renderer: one 2D canvas, drawn by hand.
 *
 * sigma is not used here and the reason is the unit system rather than taste.
 * sigma sizes nodes in SCREEN pixels, which is right for a graph whose discs
 * should stay legible at any zoom and wrong for this, where a folder circle IS
 * the container its children sit inside and has to grow with the camera. Owning
 * the canvas also removes the problem that would otherwise need solving: the
 * usual trick of layering a second canvas over sigma exists because sigma owns
 * its own, and with one context the rings, the dots and the labels are three
 * passes in one transform.
 *
 * Nothing here needs WebGL. Measured with a full redraw per frame: 0.6ms for
 * a private monorepo (995 files, 186 folders) and 1.0ms for langchain (1,766 files,
 * 315 folders), against a 16.7ms budget.
 */

/** Screen radius a circle has to reach before its name is worth the space. */
const NAME_FOLDER = 26;
const NAME_FILE = 9;
/** Cell size for the screen-space index of drawn dots, used by label placement. */
const LABEL_CELL = 64;

/**
 * Edge ink. One CSS pixel wide, because a curve that reads as a line rather
 * than as a thread competes with the dots it connects; the density comes from
 * strands stacking, not from weight.
 */
const EDGE_WIDTH = 1;

/**
 * How loud a crossing is, against how exceptional crossing IS in this repo.
 *
 * Emphasis marks what is unusual, so how much to give it is a property of the
 * repo rather than a constant. Measured over eight cached analyses the share
 * of edges that leave a package runs from 0.8% to 38.5% -- reposhape draws
 * one crossing in 118 edges, a private monorepo 121 in 2,710, langchain 1,296 in
 * 3,642. The first of those is the answer to "how is this repo joined at all"
 * and has to be unmissable; the last is a third of the drawing, where calling
 * it exceptional is simply false, and the honest report is that it settles
 * toward the fabric it is a third of.
 *
 * This went in backwards first. The plan was to push the GROUND further down
 * on a busy repo to widen the gap, and the render killed it: at that mix the
 * file-to-file edges inside a folder went invisible again, which is the one
 * thing the ground exists to show. Widening the gap was the wrong goal --
 * where crossing is ordinary, the gap SHOULD close.
 */
const EMPHASIS = { rare: 0.85, common: 0.5 };
const SHARE = { rare: 0.05, common: 0.35 };

function emphasis(crossings: number, edges: number): number {
  if (edges === 0) return EMPHASIS.rare;
  const share = crossings / edges;
  const t = Math.min(1, Math.max(0, (share - SHARE.rare) / (SHARE.common - SHARE.rare)));
  return EMPHASIS.rare + (EMPHASIS.common - EMPHASIS.rare) * t;
}

/**
 * The ground: every edge in the repo, in its own cluster's colour mixed most
 * of the way down into the background.
 *
 * It was one flat grey first, and grey on a near-black ground is not a colour,
 * it is an absence -- the file-to-file edges inside a folder were there and
 * could not be seen, which is the whole thing the ground exists to show. Hue
 * carries it where brightness cannot, and mixing toward the background keeps
 * it a ground rather than a second drawing competing with the emphasis.
 *
 * One `Path2D` PER INK rather than a loop of strokes, which is what makes it a
 * ground at all. Overlapping alpha STACKS across separate strokes, so a low
 * alpha does not turn a drawing down, it turns its DENSITY up -- measured on
 * langchain at 0.09, a fused trunk of twenty came back to full opacity while
 * every single edge vanished. A stroke of one accumulated path rasterizes as a
 * single coverage mask and has no density at all. Grouping by ink keeps that
 * property inside a cluster, which is where nearly all the overlap is, and
 * costs one stroke per cluster instead of one per strand.
 */
const GROUND_MIX = 0.62;
const FOCUS_WIDTH = 1.7;
const FOCUS_ALPHA = 0.92;

/** Half the arrowhead's base, in screen pixels. Its length lives in `mapEdges`,
 * which needs it to decide whether a circle is big enough to point at. */
const HEAD_WIDTH = 2.6;

/**
 * Direction ink, and the one place in this tab where colour is not the cluster.
 *
 * That is the point rather than an inconsistency: the pack already puts an
 * importer beside its import, so position cannot say which way round they are,
 * and the community colour is the same fact the rest of the map is carrying.
 * Warm is what the subject pulls in, cool is who pulls from it, and the pair is
 * deliberately outside the palette so a focused edge never reads as somebody's
 * cluster. The arrowheads say the same thing without a legend; these remain
 * because they read at a glance across the whole fan, where an arrow has to be
 * found first.
 */
const FLOWS: Record<ColorScheme, Record<Flow, string>> = {
  dark: { out: "#ffb15e", in: "#4fd0f2", both: "#c79bff" },
  light: { out: "#b45309", in: "#0369a1", both: "#6d28d9" },
};

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 400;
const FLIGHT_MS = 380;

/**
 * Ring ink by depth. These sit between the ground and the label: a ring that
 * reads as a line rather than as a boundary turns the drawing into a diagram.
 */
const RINGS: Record<ColorScheme, readonly string[]> = {
  dark: ["#3c3c5c", "#32324e", "#292941", "#232339", "#1f1f33"],
  light: ["#c3c8d4", "#ccd1db", "#d5d9e2", "#dce0e7", "#e1e4ea"],
};

interface Camera {
  k: number;
  x: number;
  y: number;
}

interface Dot {
  cx: number;
  cy: number;
  screenR: number;
}

interface Label {
  text: string;
  cx: number;
  cy: number;
  screenR: number;
  folder: boolean;
  dot: Dot | null;
  forced: boolean;
}

/**
 * A cluster colour at ground level. Memoised because it is asked for every
 * strand of every frame and the answer only changes with the theme.
 */
const SUNKEN = new Map<string, string>();
function sunken(ink: string, ground: string): string {
  const key = `${ink}|${ground}`;
  const found = SUNKEN.get(key);
  if (found) return found;
  const mixed = mixHex(ink, ground, GROUND_MIX);
  SUNKEN.set(key, mixed);
  return mixed;
}

function domScheme(): ColorScheme {
  if (typeof document !== "undefined" && document.documentElement.classList.contains("light")) {
    return "light";
  }
  return "dark";
}

interface Size {
  width: number;
  height: number;
}

function fitCamera(width: number, height: number): Camera {
  const k = (Math.min(width, height) - 32) / MAP_SIZE;
  return { k, x: (width - MAP_SIZE * k) / 2, y: (height - MAP_SIZE * k) / 2 };
}

/**
 * The same view, in a pane that changed size.
 *
 * Re-fitting on every resize threw away wherever the reader had got to, and it
 * did it at the worst possible moment: opening the file pane takes a third of
 * the canvas away, and clicking a file is what opens the file pane. Zoom in on
 * a folder, click one of its dots to read it, and the map jumped back to the
 * whole repo.
 *
 * So the world point under the pane's centre stays under it, and the scale
 * moves by the ratio of the two fits. That second part is what keeps a fitted
 * view fitted -- given the fit camera this returns the new fit exactly -- while
 * a reader twenty times in stays twenty times in. Double-click is still the way
 * back to the whole repo, and it is now the only one.
 */
function reframe(
  camera: Camera,
  was: Size,
  now: Size,
  hold: { x: number; y: number } | null,
): Camera {
  const fitWas = fitCamera(was.width, was.height).k;
  const fitNow = fitCamera(now.width, now.height).k;
  if (!(fitWas > 0) || !(fitNow > 0) || !(camera.k > 0)) {
    return fitCamera(now.width, now.height);
  }
  // `hold` is the circle a click just opened. Keeping the pane's centre is the
  // right default, but it is the wrong answer for the gesture that causes this
  // resize in the first place: the file pane eats the right half, so a dot
  // clicked on that side would be centred away under the pane it opened.
  const worldX = hold ? hold.x : (was.width / 2 - camera.x) / camera.k;
  const worldY = hold ? hold.y : (was.height / 2 - camera.y) / camera.k;
  const k = camera.k * (fitNow / fitWas);
  return { k, x: now.width / 2 - worldX * k, y: now.height / 2 - worldY * k };
}

/** Cubic in-out, so a flight into a folder starts and lands without a jerk. */
function ease(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

function cameraOnto(circle: MapCircle, width: number, height: number): Camera {
  const k = Math.min(MAX_ZOOM, (Math.min(width, height) * 0.92) / (circle.r * 2));
  return { k, x: width / 2 - circle.x * k, y: height / 2 - circle.y * k };
}

/**
 * The deepest circle under a point, following the same open/collapsed rule the
 * drawing uses, so what a click hits is always what the reader can see.
 */
function circleAt(root: MapCircle, camera: Camera, px: number, py: number): MapCircle | null {
  let found: MapCircle | null = null;
  const visit = (circle: MapCircle) => {
    const cx = circle.x * camera.k + camera.x;
    const cy = circle.y * camera.k + camera.y;
    const screenR = circle.r * camera.k;
    if ((px - cx) ** 2 + (py - cy) ** 2 > screenR ** 2) return;
    found = circle;
    if (circle.children.length > 0 && screenR >= COLLAPSE) circle.children.forEach(visit);
  };
  visit(root);
  return found;
}

export function MapCanvas({
  view,
  sizing,
  edges,
  onOpenFile,
  onDismiss,
  onSummary,
}: {
  view: GraphView;
  sizing: Sizing;
  /** Draw the imports that cross a package boundary. See `mapEdges`. */
  edges: boolean;
  onOpenFile: (path: string) => void;
  /** A click on nothing: the reader is putting the file pane away. */
  onDismiss?: () => void;
  /** What the edge rule resolved to, so the stats line can say it. */
  onSummary?: (summary: EdgeSummary | null) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const camera = useRef<Camera | null>(null);
  // The pane size the current camera was framed for. A resize needs the OLD one
  // to know what moved, and `getBoundingClientRect` only ever answers for now.
  const pane = useRef<Size | null>(null);
  // The circle a click just opened, in layout units, for the resize that click
  // is about to cause. Cleared by whichever resize consumes it, so it never
  // survives to steer an unrelated one.
  const held = useRef<{ x: number; y: number } | null>(null);
  const frame = useRef<number | null>(null);
  const flight = useRef<number | null>(null);
  const { resolvedTheme } = useTheme();
  const scheme: ColorScheme =
    resolvedTheme === "dark" || resolvedTheme === "light" ? resolvedTheme : domScheme();

  // Packed once per view and sizing. A camera move never re-runs this, which is
  // what makes the drawing the same picture every time it is opened.
  const layout = useMemo(() => packView(view, sizing, domScheme()), [view, sizing]);
  /**
   * The crossing edges, resolved against the packing. Built only for the tab
   * that draws them, because it walks every edge in the view.
   */
  const edgeIndex = useMemo(
    () => (edges ? buildEdgeIndex(layout, view) : null),
    [edges, layout, view],
  );
  /**
   * Bundled geometry for one camera scale. An edge ends on the circle the
   * camera SHOWS, so the routing changes when a zoom opens a folder and at no
   * other time -- which means a pan re-uses this and only a zoom rebuilds it.
   */
  const strands = useRef<{ index: object; k: number; drawn: Strand[] } | null>(null);
  /**
   * The hovered circle's own edges, cached on the circle as well as the scale.
   * The chip follows the cursor, so a redraw happens on every pointer move
   * while something is hovered; only a move to a DIFFERENT circle is worth
   * rebuilding for.
   */
  const focus = useRef<{ index: object; k: number; path: string; built: Focus } | null>(null);
  /** The circle under the cursor, and where the cursor is, in CSS pixels. */
  const hover = useRef<MapCircle | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  /**
   * The circle a click left behind, which keeps its edges drawn once the
   * cursor has gone. Hover alone cannot answer the question the edges pose:
   * following a strand to its far end means looking away from the dot holding
   * the drawing up, and the drawing leaves with you.
   *
   * Only on the edges tab, because only there is the cursor carrying something
   * that has to survive it. The plain map already says what is selected by
   * inking the disc, and a chip parked over it permanently would be a label
   * nobody asked for.
   */
  const pinned = useRef<MapCircle | null>(null);

  const draw = useCallback(() => {
    frame.current = null;
    const element = canvas.current;
    const box = container.current?.getBoundingClientRect();
    if (!element || !box || box.width === 0 || box.height === 0) return;
    const context = element.getContext("2d");
    if (!context) return;
    const active = camera.current ?? (camera.current = fitCamera(box.width, box.height));
    const colors = SCHEMES[domScheme()];
    const rings = RINGS[domScheme()];
    const { focusedPath, search, dimmed } = useFilters.getState();
    const query = search.trim().toLowerCase();

    // Two separate jobs, and conflating them is what smeared the drawing. The
    // CLEAR covers the whole backing store in device pixels, because a folder
    // ring at depth is stroked far outside the pane and a clear bounded by the
    // pane leaves that arc on screen for every later frame. The TRANSFORM then
    // carries the device ratio, so everything after this -- the camera, the
    // labels, and the pointer coordinates the camera is anchored on -- is in
    // one unit system, CSS pixels.
    const ratio = box.width > 0 ? element.width / box.width : 1;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.fillStyle = colors.ground;
    context.fillRect(0, 0, element.width, element.height);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);

    const labels: Label[] = [];
    const dots: Dot[] = [];
    // What the reader is asking about: the cursor if it is on something, else
    // whatever a click left pinned.
    const subject = hover.current ?? pinned.current;
    context.save();
    context.translate(active.x, active.y);
    context.scale(active.k, active.k);

    let focused: Focus | null = null;
    if (edgeIndex) {
      if (strands.current?.k !== active.k || strands.current.index !== edgeIndex) {
        strands.current = { index: edgeIndex, k: active.k, drawn: buildStrands(edgeIndex, active.k) };
      }
      // An edge is drawn only when one of its ENDS is on the pane. A bundle
      // whose ends are both off screen contributes a chord across everything,
      // and at a deep zoom a dozen of those are a hatch over the dots that says
      // nothing about what the reader is looking at.
      const left = -active.x / active.k;
      const top = -active.y / active.k;
      const right = (box.width - active.x) / active.k;
      const bottom = (box.height - active.y) / active.k;
      const onPane = (end: readonly [number, number]) =>
        end[0] >= left && end[0] <= right && end[1] >= top && end[1] <= bottom;
      if (subject) {
        if (
          focus.current?.k !== active.k ||
          focus.current.index !== edgeIndex ||
          focus.current.path !== subject.path
        ) {
          focus.current = {
            index: edgeIndex,
            k: active.k,
            path: subject.path,
            built: buildFocus(edgeIndex, subject, active.k),
          };
        }
        focused = focus.current.built;
      }
      // Under the dots, because a dot the reader is aiming at must not be
      // covered by the traffic leaving it. `source-over` rather than `lighter`:
      // additive stacking takes a busy trunk to white, and the cluster hue is
      // the only import fact the rest of the map carries.
      context.lineCap = "round";
      context.lineWidth = EDGE_WIDTH / active.k;
      const visible = strands.current.drawn.filter(
        (strand) => onPane(strand.from) || onPane(strand.to),
      );
      // The ground: all of them, flat. Most are twenty pixels long and live
      // inside one folder -- which is the packing's whole claim, that position
      // already says what an edge would -- so they read as the texture of a
      // folder rather than as lines worth following.
      const ground = new Map<string, Path2D>();
      for (const strand of visible) {
        const ink = sunken(strand.ink, colors.ground);
        let path = ground.get(ink);
        if (!path) ground.set(ink, (path = new Path2D()));
        path.addPath(strand.path);
      }
      for (const [ink, path] of ground) {
        context.strokeStyle = ink;
        context.stroke(path);
      }
      // And the emphasis on top, unless a subject has taken it.
      if (!focused) {
        context.globalAlpha = emphasis(edgeIndex.crossings, edgeIndex.edges.length);
        for (const strand of visible) {
          if (!strand.crossing) continue;
          context.strokeStyle = strand.ink;
          context.stroke(strand.path);
        }
      }
      // No endpoint cull on these: one end of every one of them is the circle
      // the cursor is on, so each is by definition touching what is in front
      // of the reader.
      if (focused) {
        const flows = FLOWS[domScheme()];
        context.lineWidth = FOCUS_WIDTH / active.k;
        context.globalAlpha = FOCUS_ALPHA;
        for (const strand of focused.strands) {
          context.strokeStyle = flows[strand.flow];
          context.stroke(strand.path);
        }
        // Heads in a second pass, so one strand crossing another never draws
        // over its head. They are the thing being read; the curve is how you
        // get to them.
        const long = HEAD_LENGTH / active.k;
        const wide = HEAD_WIDTH / active.k;
        for (const strand of focused.strands) {
          if (strand.heads.length === 0) continue;
          context.fillStyle = flows[strand.flow];
          for (const head of strand.heads) {
            const backX = head.x - head.dx * long;
            const backY = head.y - head.dy * long;
            context.beginPath();
            context.moveTo(head.x, head.y);
            context.lineTo(backX - head.dy * wide, backY + head.dx * wide);
            context.lineTo(backX + head.dy * wide, backY - head.dx * wide);
            context.closePath();
            context.fill();
          }
        }
      }
      context.globalAlpha = 1;
    }

    const visit = (circle: MapCircle) => {
      const screenR = circle.r * active.k;
      if (screenR < 0.35) return;
      const cx = circle.x * active.k + active.x;
      const cy = circle.y * active.k + active.y;
      // Nothing off the pane needs drawing, and nothing inside it needs
      // visiting. This is what keeps a deep zoom cheaper than a fitted one.
      if (
        cx + screenR < 0 ||
        cy + screenR < 0 ||
        cx - screenR > box.width ||
        cy - screenR > box.height
      ) {
        return;
      }

      if (circle.children.length > 0 && screenR >= COLLAPSE) {
        if (circle.depth > 0) {
          context.beginPath();
          context.arc(circle.x, circle.y, circle.r, 0, Math.PI * 2);
          context.strokeStyle = rings[Math.min(circle.depth - 1, rings.length - 1)]!;
          context.lineWidth = 1.15 / active.k;
          context.stroke();
          if (screenR >= NAME_FOLDER) {
            labels.push({ text: circle.name, cx, cy, screenR, folder: true, dot: null, forced: false });
          }
        }
        circle.children.forEach(visit);
        return;
      }

      const focused = circle.isFile && circle.path === focusedPath;
      const hit = query.length > 0 && circle.path.toLowerCase().includes(query);
      let ink = circle.ink;
      if (dimmed.has(circle.path)) ink = colors.dimNode;
      else if (focused) ink = colors.selected;
      else if (query.length > 0 && !hit) ink = colors.dimNode;

      context.beginPath();
      context.arc(circle.x, circle.y, circle.r, 0, Math.PI * 2);
      context.fillStyle = ink;
      context.fill();
      // A folder too small to open is still a folder. Ringed, because with
      // every file the same size a larger dot would otherwise read as one
      // unusually large file, which is the one ambiguity uniform sizing adds.
      if (circle.children.length > 0) {
        context.strokeStyle = colors.ground;
        context.lineWidth = 2.2 / active.k;
        context.stroke();
        context.beginPath();
        context.arc(circle.x, circle.y, circle.r + 2.6 / active.k, 0, Math.PI * 2);
        context.strokeStyle = rings[Math.min(Math.max(circle.depth - 1, 0), rings.length - 1)]!;
        context.lineWidth = 1.15 / active.k;
        context.stroke();
      }

      const dot: Dot = { cx, cy, screenR };
      dots.push(dot);
      if (circle.isFile && (focused || hit || screenR >= NAME_FILE)) {
        labels.push({
          text: circle.name,
          cx,
          cy,
          screenR,
          folder: false,
          dot,
          forced: focused || hit,
        });
      }
    };
    visit(layout);
    context.restore();

    drawLabels(context, labels, dots, colors, box.width);

    if (subject) {
      const cx = subject.x * active.k + active.x;
      const cy = subject.y * active.k + active.y;
      const screenR = subject.r * active.k;
      // The ring first, because the chip sits beside the cursor rather than on
      // the dot, and at fit a dot is three pixels across.
      context.beginPath();
      context.arc(cx, cy, screenR + 2.5, 0, Math.PI * 2);
      context.strokeStyle = colors.labelFocused;
      context.lineWidth = 1.5;
      context.stroke();
      // A pinned circle has no cursor to sit beside, so its chip goes on the
      // circle instead, off to the lower right for the reason the hover chip
      // is offset at all: a chip over the dot hides what it is naming. Anchored
      // to the VISIBLE centre, because a folder flown into is bigger than the
      // pane and its real centre can be off screen -- which put the chip in the
      // far corner, as far from the thing it named as the pane allows.
      const reach = Math.min(screenR * 0.72, 120);
      const at =
        hover.current === subject && pointer.current
          ? pointer.current
          : {
              x: Math.min(Math.max(cx, 0) + reach, box.width - 8),
              y: Math.min(Math.max(cy, 0) + reach, box.height - 8),
            };
      drawHoverChip(context, subject, at, colors, rings, box.width, box.height, focused);
    }
  }, [edgeIndex, layout]);

  useEffect(() => {
    onSummary?.(
      edgeIndex ? { packages: edgeIndex.packages, crossing: edgeIndex.crossings } : null,
    );
    // Cleared on the way out as well, or leaving this tab leaves the stats
    // line describing a rule that is no longer drawing anything.
    return () => onSummary?.(null);
  }, [edgeIndex, onSummary]);

  const schedule = useCallback(() => {
    if (frame.current === null) frame.current = requestAnimationFrame(draw);
  }, [draw]);

  const flyTo = useCallback(
    (circle: MapCircle) => {
      const box = container.current?.getBoundingClientRect();
      if (!box || camera.current === null) return;
      const from = camera.current;
      const to = cameraOnto(circle, box.width, box.height);
      const started = performance.now();
      if (flight.current !== null) cancelAnimationFrame(flight.current);
      const step = () => {
        const t = Math.min(1, (performance.now() - started) / FLIGHT_MS);
        const e = ease(t);
        camera.current = {
          k: from.k + (to.k - from.k) * e,
          x: from.x + (to.x - from.x) * e,
          y: from.y + (to.y - from.y) * e,
        };
        draw();
        flight.current = t < 1 ? requestAnimationFrame(step) : null;
      };
      flight.current = requestAnimationFrame(step);
    },
    [draw],
  );

  // Sizing and the view both change the geometry, so the camera goes back to a
  // fit rather than staying pointed at coordinates that now mean something else.
  useEffect(() => {
    camera.current = null;
    pinned.current = null;
    schedule();
  }, [layout, schedule]);

  /**
   * Re-resolve what the cursor is over. Called from the pointer AND from the
   * wheel: a zoom moves the drawing under a stationary cursor, and a chip that
   * keeps naming the dot that used to be there is worse than no chip.
   *
   * Returns whether the frame is worth redrawing -- true while something is
   * hovered, since the chip follows the cursor, and once more when the last
   * hover is dropped.
   */
  const updateHover = useCallback(
    (px: number, py: number) => {
      const active = camera.current;
      const box = container.current?.getBoundingClientRect();
      if (!active || !box) return false;
      const found = circleAt(layout, active, px, py);
      // Depth zero is the repo itself, which every point is inside. An OPEN
      // folder bigger than the pane is the other thing worth refusing: the
      // cursor is in the gap between its dots, so naming it tells the reader
      // where they already are and rings a boundary they cannot see. Open and
      // small enough to take in whole is still worth naming -- at fit, that is
      // how a coloured blob gets identified without clicking into it.
      const screenR = found ? found.r * active.k : 0;
      const open = found !== null && found.children.length > 0 && screenR >= COLLAPSE;
      const oversized = open && screenR * 2 > Math.min(box.width, box.height) * 0.9;
      const target = found && found.depth > 0 && !oversized ? found : null;
      const changed = (target?.path ?? null) !== (hover.current?.path ?? null);
      hover.current = target;
      pointer.current = { x: px, y: py };
      return target !== null || changed;
    },
    [layout],
  );

  const onWheel = useCallback(
    (event: WheelEvent) => {
      const box = container.current?.getBoundingClientRect();
      const active = camera.current;
      if (!box || !active) return;
      event.preventDefault();
      // A trackpad pinch arrives as a wheel with ctrlKey set and a much smaller
      // delta, so the two need different sensitivities or one of them feels
      // broken. Both anchor on the pointer, which is what makes zoom feel like
      // the drawing is being pulled rather than re-centred.
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.012 : 0.0022));
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, active.k * factor));
      const px = event.clientX - box.left;
      const py = event.clientY - box.top;
      camera.current = {
        k: next,
        x: px - (px - active.x) * (next / active.k),
        y: py - (py - active.y) * (next / active.k),
      };
      updateHover(px, py);
      schedule();
    },
    [schedule, updateHover],
  );

  useEffect(() => {
    const element = canvas.current;
    const box = container.current;
    if (!element || !box) return;

    const resize = () => {
      const rect = box.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      element.width = Math.max(1, Math.round(rect.width * ratio));
      element.height = Math.max(1, Math.round(rect.height * ratio));
      element.style.width = `${rect.width}px`;
      element.style.height = `${rect.height}px`;
      // No scale() here: draw() sets the device-ratio transform itself, from
      // the backing store it finds, so there is one place that decides it.
      const was = pane.current;
      const hold = held.current;
      held.current = null;
      pane.current = { width: rect.width, height: rect.height };
      camera.current =
        was && camera.current ? reframe(camera.current, was, pane.current, hold) : null;
      draw();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(box);
    // Native rather than React's `onWheel`: React attaches wheel listeners
    // passively, so `preventDefault` there is ignored and every turn of the
    // wheel warns. Zooming has to stop the page scrolling with it.
    element.addEventListener("wheel", onWheel, { passive: false });
    // iOS Safari takes a two-finger pinch for the page unless the gesture
    // itself is cancelled. `touch-action: none` on the canvas covers Chrome;
    // this covers Safari, which fires its own non-standard gesture events.
    const cancelGesture = (event: Event) => event.preventDefault();
    element.addEventListener("gesturestart", cancelGesture);
    element.addEventListener("gesturechange", cancelGesture);
    // The pin is the edge layer's focus and `focusedPath` is the file pane's.
    // A reader clearing one is clearing both, so losing the selection drops the
    // pin with it. Not the reverse: flying into a folder pins it and selects no
    // file at all.
    let selected = useFilters.getState().focusedPath;
    const unsubscribe = useFilters.subscribe((state) => {
      if (selected !== null && state.focusedPath === null) pinned.current = null;
      selected = state.focusedPath;
      schedule();
    });
    return () => {
      observer.disconnect();
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("gesturestart", cancelGesture);
      element.removeEventListener("gesturechange", cancelGesture);
      unsubscribe();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      if (flight.current !== null) cancelAnimationFrame(flight.current);
    };
  }, [draw, onWheel, schedule]);

  // Repaint on a theme change. The layout is untouched: colours are read live
  // from the scheme at draw time, so toggling the theme never moves a circle.
  useEffect(() => {
    schedule();
  }, [scheme, schedule]);

  const dragging = useRef<{ id: number; x: number; y: number; moved: number } | null>(null);
  // Every pointer currently on the canvas, in client pixels. One entry is a
  // pan through `dragging` above; two is a pinch, which has no handler today
  // -- the wheel listener below never fires on a phone, so pinching did
  // nothing while the sigma graph beside it zoomed. iOS Safari additionally
  // needs `gesturestart` cancelled or it takes the gesture for the page.
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number } | null>(null);
  // A pinch that moved is not two taps: the lifts ending it must not click.
  const pinchMoved = useRef(false);
  const suppressTap = useRef(false);

  const pinchOf = useCallback((box: DOMRect) => {
    const [a, b] = [...touches.current.values()];
    if (!a || !b) return null;
    const ax = a.x - box.left;
    const ay = a.y - box.top;
    const bx = b.x - box.left;
    const by = b.y - box.top;
    return { dist: Math.hypot(bx - ax, by - ay), midX: (ax + bx) / 2, midY: (ay + by) / 2 };
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (flight.current !== null) {
        cancelAnimationFrame(flight.current);
        flight.current = null;
      }
      event.currentTarget.setPointerCapture(event.pointerId);
      touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const box = container.current?.getBoundingClientRect();
      if (touches.current.size === 2 && box) {
        // The second finger turns a pan into a pinch: freeze the pan and
        // anchor the zoom on this frame's span, updated incrementally after.
        dragging.current = null;
        const measure = pinchOf(box);
        pinch.current = measure && measure.dist > 0 ? { dist: measure.dist } : null;
        pinchMoved.current = false;
        hover.current = null;
        pointer.current = null;
        return;
      }
      dragging.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: 0 };
    },
    [pinchOf],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const active = camera.current;
      const box = container.current?.getBoundingClientRect();
      if (!active || !box) return;
      if (touches.current.has(event.pointerId)) {
        touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      }
      if (pinch.current && touches.current.size >= 2) {
        const measure = pinchOf(box);
        if (measure && measure.dist > 0 && pinch.current.dist > 0) {
          const factor = measure.dist / pinch.current.dist;
          const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, active.k * factor));
          camera.current = {
            k: next,
            x: measure.midX - (measure.midX - active.x) * (next / active.k),
            y: measure.midY - (measure.midY - active.y) * (next / active.k),
          };
          pinch.current = { dist: measure.dist };
          if (Math.abs(factor - 1) > 0.001) pinchMoved.current = true;
          updateHover(measure.midX, measure.midY);
          schedule();
        }
        return;
      }
      const drag = dragging.current;
      if (drag && drag.id === event.pointerId) {
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        drag.x = event.clientX;
        drag.y = event.clientY;
        drag.moved += Math.abs(dx) + Math.abs(dy);
        camera.current = { k: active.k, x: active.x + dx, y: active.y + dy };
        // A pan is not a hover: the chip would name whatever slid under a
        // finger that is holding the drawing rather than pointing at it.
        hover.current = null;
        pointer.current = null;
        schedule();
        return;
      }
      const moved = updateHover(event.clientX - box.left, event.clientY - box.top);
      event.currentTarget.style.cursor = hover.current ? "pointer" : "default";
      if (moved) schedule();
    },
    [pinchOf, schedule, updateHover],
  );

  const onPointerLeave = useCallback(() => {
    if (hover.current === null) return;
    hover.current = null;
    pointer.current = null;
    schedule();
  }, [schedule]);

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      touches.current.delete(event.pointerId);
      if (pinch.current || suppressTap.current) {
        // The pinch is over once fewer than two fingers remain. A remaining
        // finger goes back to panning from where it is, and no lift in this
        // sequence is a tap.
        if (touches.current.size < 2) {
          pinch.current = null;
          suppressTap.current = pinchMoved.current || suppressTap.current;
          if (touches.current.size === 0) {
            const suppress = suppressTap.current;
            suppressTap.current = false;
            pinchMoved.current = false;
            dragging.current = null;
            if (suppress) return;
          } else {
            const [rest] = [...touches.current.entries()];
            if (rest) dragging.current = { id: rest[0], x: rest[1].x, y: rest[1].y, moved: 0 };
            return;
          }
        } else {
          return;
        }
      }
      const drag = dragging.current;
      dragging.current = null;
      const box = container.current?.getBoundingClientRect();
      const active = camera.current;
      if (!drag || !box || !active) return;
      // A drag that moved the stage was a pan, not a click on whatever happens
      // to be under the finger when it lifts.
      if (drag.moved > 5) return;
      const target = circleAt(
        layout,
        active,
        event.clientX - box.left,
        event.clientY - box.top,
      );
      hover.current = null;
      const { setFocus } = useFilters.getState();
      if (!target || target.depth === 0) {
        pinned.current = null;
        setFocus(null);
        onDismiss?.();
        return;
      }
      // The pin rides the gestures that already exist rather than adding one:
      // a file was already being selected and opened, a folder was already
      // being flown into, and both now leave their edges on screen. Flying in
      // is the case that earns it -- the folder fills the pane, its own dots
      // are what the reader is now among, and the strands leaving it are the
      // only thing left saying where they came from.
      pinned.current = edges ? target : null;
      if (target.isFile) {
        held.current = { x: target.x, y: target.y };
        setFocus(target.path);
        onOpenFile(target.path);
        return;
      }
      flyTo(target);
    },
    [edges, flyTo, layout, onDismiss, onOpenFile],
  );

  const onDoubleClick = useCallback(() => {
    const box = container.current?.getBoundingClientRect();
    if (!box) return;
    hover.current = null;
    camera.current = fitCamera(box.width, box.height);
    schedule();
  }, [schedule]);

  return (
    <div ref={container} className="absolute inset-0" style={{ background: SCHEMES[scheme].ground }}>
      <canvas
        ref={canvas}
        className="block touch-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerLeave}
        onDoubleClick={onDoubleClick}
      />
    </div>
  );
}

/**
 * Labels, in screen space, biggest circle first.
 *
 * The first pass of this wrote every name at its circle's edge and the drawing
 * read as clutter -- not because labels collided with each other, which was
 * already handled, but because they were written ACROSS the dots below them. So
 * a label also refuses to sit on a dot, tested against a screen-space grid, and
 * each one gets a second placement to try before it is dropped. Without the
 * alternate, the dot test silently swallowed most folder names, which is worse
 * than a name sitting slightly off its own circle.
 */
function drawLabels(
  context: CanvasRenderingContext2D,
  labels: Label[],
  dots: Dot[],
  colors: (typeof SCHEMES)[ColorScheme],
  width: number,
): void {
  const grid = new Map<string, Dot[]>();
  for (const dot of dots) {
    const x0 = Math.floor((dot.cx - dot.screenR) / LABEL_CELL);
    const x1 = Math.floor((dot.cx + dot.screenR) / LABEL_CELL);
    const y0 = Math.floor((dot.cy - dot.screenR) / LABEL_CELL);
    const y1 = Math.floor((dot.cy + dot.screenR) / LABEL_CELL);
    for (let gx = x0; gx <= x1; gx += 1) {
      for (let gy = y0; gy <= y1; gy += 1) {
        const key = `${gx}:${gy}`;
        const bucket = grid.get(key);
        if (bucket) bucket.push(dot);
        else grid.set(key, [dot]);
      }
    }
  }

  const hitsDot = (x: number, y: number, half: number, size: number, own: Dot | null) => {
    const x0 = Math.floor((x - half) / LABEL_CELL);
    const x1 = Math.floor((x + half) / LABEL_CELL);
    const y0 = Math.floor((y - size / 2) / LABEL_CELL);
    const y1 = Math.floor((y + size / 2) / LABEL_CELL);
    for (let gx = x0; gx <= x1; gx += 1) {
      for (let gy = y0; gy <= y1; gy += 1) {
        for (const dot of grid.get(`${gx}:${gy}`) ?? []) {
          if (dot === own) continue;
          const dx = Math.max(Math.abs(dot.cx - x) - half, 0);
          const dy = Math.max(Math.abs(dot.cy - y) - size * 0.45, 0);
          if (dx * dx + dy * dy < dot.screenR * dot.screenR) return true;
        }
      }
    }
    return false;
  };

  const kept: { x: number; y: number; half: number; size: number }[] = [];
  context.textAlign = "center";
  context.textBaseline = "middle";
  for (const label of [...labels].sort((a, b) => b.screenR - a.screenR)) {
    const size = label.folder ? Math.min(label.screenR * 0.3, 17) : 11;
    context.font = `${label.folder ? 500 : 400} ${size}px system-ui, -apple-system, sans-serif`;
    const half = context.measureText(label.text).width / 2 + 3;
    if (label.cx + half < 0 || label.cx - half > width) continue;
    const slots = label.folder
      ? [label.cy - label.screenR + size * 0.95, label.cy - label.screenR - size * 0.55]
      : [label.cy + label.screenR + size * 0.8, label.cy - label.screenR - size * 0.6];
    let placed: number | null = null;
    for (const candidate of slots) {
      const collides = kept.some(
        (other) =>
          Math.abs(label.cx - other.x) < half + other.half &&
          Math.abs(candidate - other.y) < (size + other.size) * 0.62,
      );
      if (collides) continue;
      if (!label.forced && hitsDot(label.cx, candidate, half, size, label.dot)) continue;
      placed = candidate;
      break;
    }
    if (placed === null) continue;
    kept.push({ x: label.cx, y: placed, half, size });
    context.fillStyle = label.forced ? colors.labelFocused : colors.label;
    context.globalAlpha = label.folder ? 0.95 : 0.75;
    context.fillText(label.text, label.cx, placed);
    context.globalAlpha = 1;
  }
}

/** Trim a path from the LEFT, since the tail is the part that identifies it. */
function fit(context: CanvasRenderingContext2D, text: string, limit: number): string {
  if (context.measureText(text).width <= limit) return text;
  const segments = text.split("/");
  let kept = segments.slice(-1).join("/");
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    const candidate = segments.slice(index).join("/");
    if (context.measureText(`…/${candidate}`).width > limit) break;
    kept = candidate;
  }
  return `…/${kept}`;
}

/**
 * The name of the thing under the cursor.
 *
 * The label pass drops any name that would sit on a dot, which is right for a
 * drawing read at a glance and useless for the one dot being pointed at -- at
 * fit, that is every file in the repo. So the chip answers the two questions
 * the picture cannot: which file is this, and where does it live. The second
 * line is not decoration; this repo has eleven files called `index.ts` and a
 * bare name identifies none of them.
 *
 * On the edges tab it answers a third, which is the one the drawing cannot:
 * how many. Bundling fuses every import into a collapsed folder onto one
 * curve, so the reader can see THAT this file reaches into `sidecar` without
 * being able to see that it does so nine times. The two counts also carry the
 * colour key for the strands, which is why each is written in its own ink and
 * not in the caption grey.
 */
function drawHoverChip(
  context: CanvasRenderingContext2D,
  circle: MapCircle,
  at: { x: number; y: number },
  colors: (typeof SCHEMES)[ColorScheme],
  rings: readonly string[],
  width: number,
  height: number,
  focused: Focus | null,
): void {
  const TITLE = 12.5;
  const DETAIL = 11;
  const PAD_X = 9;
  const PAD_Y = 7;
  const GAP = 3;

  const title = circle.name;
  context.font = `500 ${TITLE}px system-ui, -apple-system, sans-serif`;
  const titleWidth = context.measureText(title).width;

  const parent = circle.path.slice(0, Math.max(0, circle.path.length - circle.name.length - 1));
  const detail = circle.isFile
    ? parent || "repo root"
    : `${circle.files.toLocaleString()} file${circle.files === 1 ? "" : "s"}`;
  context.font = `400 ${DETAIL}px system-ui, -apple-system, sans-serif`;
  const trimmed = circle.isFile ? fit(context, detail, Math.max(120, width * 0.4)) : detail;
  const detailWidth = context.measureText(trimmed).width;

  const flows = FLOWS[domScheme()];
  const counts = focused
    ? {
        out: `${focused.outgoing.toLocaleString()} import${focused.outgoing === 1 ? "" : "s"}`,
        dot: "  ·  ",
        in: `${focused.incoming.toLocaleString()} importer${focused.incoming === 1 ? "" : "s"}`,
      }
    : null;
  const countWidth = counts
    ? context.measureText(counts.out).width +
      context.measureText(counts.dot).width +
      context.measureText(counts.in).width
    : 0;

  const boxWidth = Math.max(titleWidth, detailWidth, countWidth) + PAD_X * 2;
  const boxHeight =
    TITLE + GAP + DETAIL + PAD_Y * 2 + (counts ? GAP + DETAIL : 0);
  // Below and right of the cursor, which is where a tooltip is expected, and
  // flipped rather than clipped at either far edge of the pane.
  let x = at.x + 16;
  let y = at.y + 18;
  if (x + boxWidth > width - 6) x = Math.max(6, at.x - 16 - boxWidth);
  if (y + boxHeight > height - 6) y = Math.max(6, at.y - 18 - boxHeight);

  context.beginPath();
  context.roundRect(x, y, boxWidth, boxHeight, 6);
  context.fillStyle = colors.hoverGround;
  context.fill();
  context.strokeStyle = rings[0]!;
  context.lineWidth = 1;
  context.stroke();

  context.textAlign = "left";
  context.textBaseline = "top";
  context.fillStyle = colors.labelFocused;
  context.font = `500 ${TITLE}px system-ui, -apple-system, sans-serif`;
  context.fillText(title, x + PAD_X, y + PAD_Y);
  context.fillStyle = colors.label;
  context.font = `400 ${DETAIL}px system-ui, -apple-system, sans-serif`;
  context.fillText(trimmed, x + PAD_X, y + PAD_Y + TITLE + GAP);
  if (!counts) return;
  let run = x + PAD_X;
  const line = y + PAD_Y + TITLE + GAP + DETAIL + GAP;
  for (const [text, ink] of [
    [counts.out, flows.out],
    [counts.dot, colors.label],
    [counts.in, flows.in],
  ] as const) {
    context.fillStyle = ink;
    context.fillText(text, run, line);
    run += context.measureText(text).width;
  }
}
