"use client";

import Sigma from "sigma";
import type { EdgeDisplayData, NodeDisplayData } from "sigma/types";
import { useTheme } from "next-themes";
import { useEffect, useMemo, useRef, type RefObject } from "react";

import {
  addRuntimeLinks,
  applySchemeColors,
  buildGraph,
  layout,
  SCHEMES,
  type ColorScheme,
  type EdgeAttributes,
  type ImportGraph,
  type NodeAttributes,
} from "@/features/graph/graphModel";
import {
  CurvedArrowProgram,
  EdgeCurvedDashedProgram,
  EdgeCurvedLineProgram,
} from "@/features/graph/curvedEdgeProgram";
import type { NodeHoverDrawingFunction } from "sigma/rendering";
import { useFilters } from "@/features/filters/filterStore";
import type { GraphView } from "@/generated/contracts";

/**
 * Sigma's stock hover pill is hardcoded white, which whites out a white
 * label (measured on tap: a blank white bar where the name should be). Same
 * geometry, the scheme's ground instead, text in the current label color so
 * it reads in both rest and focused states.
 */
function makeHoverPill(
  ground: string,
  shadow: string,
): NodeHoverDrawingFunction<NodeAttributes, EdgeAttributes> {
  return (context, data, settings) => {
    const size = settings.labelSize;
    context.font = `${settings.labelWeight} ${size}px ${settings.labelFont}`;
    context.fillStyle = ground;
    context.shadowOffsetX = 0;
    context.shadowOffsetY = 0;
    context.shadowBlur = 8;
    context.shadowColor = shadow;
    const PADDING = 2;
    if (typeof data.label === "string") {
      const textWidth = context.measureText(data.label).width;
      const boxWidth = Math.round(textWidth + 5);
      const boxHeight = Math.round(size + 2 * PADDING);
      const radius = Math.max(data.size, size / 2) + PADDING;
      const angleRadian = Math.asin(boxHeight / 2 / radius);
      const xDeltaCoord = Math.sqrt(Math.abs(radius ** 2 - (boxHeight / 2) ** 2));
      context.beginPath();
      context.moveTo(data.x + xDeltaCoord, data.y + boxHeight / 2);
      context.lineTo(data.x + radius + boxWidth, data.y + boxHeight / 2);
      context.lineTo(data.x + radius + boxWidth, data.y - boxHeight / 2);
      context.lineTo(data.x + xDeltaCoord, data.y - boxHeight / 2);
      context.arc(data.x, data.y, radius, angleRadian, -angleRadian);
      context.closePath();
      context.fill();
    } else {
      context.beginPath();
      context.arc(data.x, data.y, data.size + PADDING, 0, Math.PI * 2);
      context.closePath();
      context.fill();
    }
    context.shadowOffsetX = 0;
    context.shadowOffsetY = 0;
    context.shadowBlur = 0;

    if (!data.label) return;
    context.fillStyle = settings.labelColor.color ?? "#ffffff";
    context.fillText(data.label, data.x + data.size + 3, data.y + size / 3);
  };
}

/**
 * The scheme on the <html> class list, which next-themes settles before first
 * paint and keeps current afterwards. Read live (not from React state) so the
 * filter subscription below always paints the settled scheme without
 * resubscribing, and the first frame is already correct for a light reader.
 */
function domScheme(): ColorScheme {
  if (typeof document !== "undefined" && document.documentElement.classList.contains("light")) {
    return "light";
  }
  return "dark";
}

/**
 * Everything sigma derives per frame: label chrome, the hover pill, and both
 * reducers. Called from the filter subscription and from the scheme effect
 * alike, so a theme toggle and a focus change run the same code and cannot
 * drift apart. Reducers read the store directly and only ask sigma to
 * repaint, so hovering never re-renders React and never rebuilds the graph.
 */
function applyChrome(
  renderer: Sigma<NodeAttributes, EdgeAttributes>,
  graph: ImportGraph,
  scheme: ColorScheme,
  widthFactor: RefObject<number>,
): void {
  const colors = SCHEMES[scheme];
  const { focusedPath, search, dimmed, showLinks } = useFilters.getState();
  const query = search.trim().toLowerCase();
  // A runtime link makes a neighbour only while the layer is on: with it off,
  // focus has to light exactly what the drawn edges connect.
  let neighbourhood: Set<string> | null = null;
  if (focusedPath && graph.hasNode(focusedPath)) {
    neighbourhood = new Set([focusedPath]);
    graph.forEachEdge(focusedPath, (_edge, attributes, source, target) => {
      if (attributes.runtime && !showLinks) return;
      neighbourhood?.add(source === focusedPath ? target : source);
    });
  }

  // While focused, exactly one label is ever forced: the focused node's.
  // Forcing the neighbours too piled every one of them onto the same
  // pixels and buried the focused label in its own smear (measured: a
  // 9-edge leaf was unreadable, let alone an 80-edge hub). Neighbours
  // stay readable by hovering; the focused label gets bigger and takes the
  // scheme's selection colour so it holds its own over discs and edges.
  renderer.setSetting("labelSize", neighbourhood ? 14 : 11);
  renderer.setSetting("labelColor", {
    color: neighbourhood ? colors.labelFocused : colors.label,
  });
  renderer.setSetting(
    "defaultDrawNodeHover",
    makeHoverPill(colors.hoverGround, scheme === "dark" ? "#000" : "rgba(17,19,26,0.25)"),
  );

  renderer.setSetting("nodeReducer", (node, data): Partial<NodeDisplayData> => {
    const next: Partial<NodeDisplayData> = {
      ...data,
      size: data.size * widthFactor.current,
    };
    // An explicitly dimmed node stays dimmed under focus too: the dim is
    // the newer, deliberate act, and exempting the focused node would make
    // the file panel's own Dim button look dead on arrival.
    if (dimmed.has(node)) {
      next.color = colors.dimNode;
      next.label = "";
      next.zIndex = 0;
      return next;
    }
    if (neighbourhood && !neighbourhood.has(node)) {
      next.color = colors.dimNode;
      next.label = "";
      next.zIndex = 0;
      return next;
    }
    if (node === focusedPath) {
      next.color = colors.selected;
      next.forceLabel = true;
      next.zIndex = 2;
      return next;
    }
    // While focused, nobody else is named: even the neighbours' own
    // threshold labels pile onto the focused one and bury it. Hover names
    // any single disc instead.
    if (neighbourhood) next.label = "";
    if (query) {
      if (node.toLowerCase().includes(query)) {
        next.forceLabel = true;
        next.zIndex = 2;
      } else if (!neighbourhood) {
        next.color = colors.dimNode;
        next.label = "";
      }
    }
    return next;
  });

  renderer.setSetting("edgeReducer", (edge, data): Partial<EdgeDisplayData> => {
    if (data.runtime && !showLinks) return { ...data, hidden: true };
    const source = graph.source(edge);
    const target = graph.target(edge);
    // Dimmed edges sink toward the ground as hex, not RENDER.dimEdge: that
    // constant is an rgba() string and the curved programs' floatColor
    // falls back to WHITE for anything that is not hex.
    if (dimmed.has(source) || dimmed.has(target)) {
      return { ...data, color: colors.dimNode };
    }
    if (!neighbourhood) return { ...data };
    // Focused edges keep their rest styling: same color, thickness,
    // un-arrowed. Focus reads through dimming everything unconnected and
    // hiding every edge that touches nothing selected, not through a
    // second edge language on top of the first.
    if (source === focusedPath || target === focusedPath) return { ...data };
    return { ...data, hidden: true };
  });

  renderer.refresh({ skipIndexation: true });
}

/**
 * Sigma is driven directly rather than through a React wrapper: lifecycle here
 * is one effect, and the reducers below need to read live store state on every
 * frame without a component re-render per hover.
 */
export function GraphCanvas({
  view,
  onOpenFile,
}: {
  view: GraphView;
  onOpenFile: (path: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const sigma = useRef<Sigma<NodeAttributes, EdgeAttributes> | null>(null);
  // The resolved theme arrives after hydration; the <html> class was settled
  // before first paint, so it is the scheme until resolvedTheme overrides it
  // afterwards. Either way this is paint, never layout: the graph below is
  // built once per view and recoloured in place.
  const { resolvedTheme } = useTheme();
  const scheme: ColorScheme =
    resolvedTheme === "dark" || resolvedTheme === "light" ? resolvedTheme : domScheme();
  // Fraction of the rest disc size to draw. Sigma's normalisation fits the
  // graph extent to any pane width, but disc sizes are absolute pixels, so a
  // half-width pane draws the same 989 discs at the same sizes over half the
  // area and reads as overlapped. Scaling discs with the pane keeps the
  // perceived density constant across single, split and inspector widths.
  const widthFactor = useRef(1);

  const graph = useMemo<ImportGraph>(() => {
    const built = buildGraph(view, domScheme());
    layout(built);
    addRuntimeLinks(built, view, domScheme());
    return built;
  }, [view]);

  // One effect owns the renderer end to end: creation, listeners, width
  // tracking and the filter subscription share one cleanup, so a resubscribe
  // can never be left pointing at a killed renderer. Split across two
  // effects with different deps, a parent re-render that changed only the
  // callback prop recreated the renderer while the subscription stayed on
  // the dead one -- and the next store change refreshed it into sigma's
  // "no suitable program" throw. Measured on a phone, where every render
  // counts.
  useEffect(() => {
    if (!container.current) return;

    const renderer = new Sigma(graph, container.current, {
      allowInvalidContainer: false,
      renderEdgeLabels: false,
      // Un-arrowed by default: 2,680 arrowheads is more ink than the edges
      // themselves and direction is unreadable at that density anyway. The
      // focused node's own edges switch to arrows in the reducer below, which
      // is where direction is both legible and wanted. Both are curved: sigma
      // ships no curved program, so line and arrow are the custom bezier
      // programs in curvedEdgeProgram.ts, registered under sigma's own type
      // names so the reducer below keeps saying "line" and "arrow".
      defaultEdgeType: "line",
      edgeProgramClasses: {
        line: EdgeCurvedLineProgram,
        arrow: CurvedArrowProgram,
        dashed: EdgeCurvedDashedProgram,
      },
      // Sigma defaults this to 1.7, which is what matted the rest view: with
      // 2,686 curves on screen the floor binds, not the 0.35 data value. 0.5
      // fades zoomed-out edges toward texture instead of merging them, and
      // thickness grows back with zoom through the sizeRatio term.
      minEdgeThickness: 0.5,
      /**
       * Edges go while the camera moves and come back when it stops, which is
       * what every graph tool does and the reason is not frame rate. Dragging
       * is how you find out where something IS, and 3,642 curves streaking
       * across the viewport is the one thing in the way of reading position
       * off the discs. sigma restores them itself: `moving` is the camera
       * animating, the captor dragging, or a wheel turning, and it schedules
       * the refresh that paints them back on mouseup.
       *
       * The frame-rate case is NOT why, and the measurement is kept so nobody
       * re-argues it from intuition. Main-thread task time over one fixed drag
       * on langchain, 1,766 nodes and 3,642 edges, five runs each: at 120
       * moves 363ms with this on against 385ms off, at 400 moves 1,073ms
       * against 1,243ms. Both differences sit inside the spread, and the same
       * configuration measured 327ms and then 385ms for the same drag in two
       * sessions an hour apart. Nothing here is faster in a way this machine
       * can show. What the setting trades is real though: sigma answers
       * mouseup with a FULL `refresh()`, re-indexing every node and edge, in
       * exchange for the frames it skipped.
       *
       * Not covered: touch. sigma reads `moving` off the MOUSE captor only,
       * with its own TODO in the render loop saying so, so a finger drag on a
       * phone still paints every edge. That wants an upstream fix rather than
       * a second mechanism here doing the same job through the reducer.
       */
      hideEdgesOnMove: true,
      /**
       * And the labels with them, for the same reason rather than a second
       * one: a label is drawn at a node's current screen position, so during
       * a drag every one of them is a word sliding across the viewport while
       * the thing it names slides under it. Text is the worst offender at
       * this because the eye tries to read it.
       *
       * Worth knowing before turning this off again: sigma's label pass is
       * also its HIGHLIGHTED-node pass, one `return` in the render loop
       * covering labels, edge labels and the hover pill together. So this
       * takes the hover pill during a drag too. That is correct here -- the
       * pointer is dragging the stage, not pointing at a disc -- but it is
       * sigma's coupling, not a decision made here, and anything that needs
       * to survive a drag cannot live in that pass.
       */
      hideLabelsOnMove: true,
      labelFont:
        '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
      labelSize: 11,
      labelColor: { color: "#c9c9d8" },
      labelDensity: 0.6,
      labelGridCellSize: 70,
      /**
       * The clean-UI rule, and better than the degree threshold it replaces.
       * graphify hid labels for nodes below 15% of max degree, fixed forever at
       * any zoom. This threshold is measured on the rendered size, so zooming in
       * reveals labels on its own and zooming out hides them again. Kept at
       * roughly half of maxNodeSize: at rest zoom only the hubs clear it.
       */
      labelRenderedSizeThreshold: 4,
      minCameraRatio: 0.05,
      maxCameraRatio: 12,
      zIndex: true,
      // Placeholder until the first applyChrome below sets the scheme's own.
      // Kept valid (never undefined) so a frame can never paint unstyled.
      defaultDrawNodeHover: makeHoverPill(SCHEMES.dark.hoverGround, "#000"),
    });
    sigma.current = renderer;

    // A click both isolates the node and opens it: the file panel carries the
    // full path plus the dim/hide controls, so selecting without opening would
    // strand them. No toggle: clicking the focused node again re-opens the
    // same file, and clicking empty stage below unfocuses.
    renderer.on("clickNode", ({ node }) => {
      const { setFocus } = useFilters.getState();
      setFocus(node);
      onOpenFile(node);
    });
    renderer.on("doubleClickNode", ({ node, event }) => {
      event.preventSigmaDefault();
      onOpenFile(node);
    });
    renderer.on("clickStage", () => useFilters.getState().setFocus(null));

    // 1300 is the measured full-pane canvas width; below it discs shrink
    // linearly to 45%, past which a phone's dots would vanish rather than
    // thin. The label threshold measures rendered size, so labels thin out
    // on their own as the discs do.
    const trackWidth = () => {
      if (!container.current || !sigma.current) return;
      const width = container.current.getBoundingClientRect().width;
      widthFactor.current = width > 0 ? Math.min(1, Math.max(0.45, width / 1300)) : 1;
      sigma.current.refresh({ skipIndexation: true });
    };
    trackWidth();
    const observer = new ResizeObserver(trackWidth);
    if (container.current) observer.observe(container.current);

    // The subscription only repaints with the settled scheme, so toggling the
    // theme never needs to resubscribe and can never strand a refresh on a
    // dead renderer.
    const apply = () => applyChrome(renderer, graph, domScheme(), widthFactor);

    apply();
    const unsubscribe = useFilters.subscribe(apply);

    return () => {
      unsubscribe();
      observer.disconnect();
      renderer.kill();
      sigma.current = null;
    };
  }, [graph, onOpenFile]);

  // A scheme change repaints data colours in place: no rebuild, no relayout,
  // no camera reset, no fetch. The renderer above persists across it, so this
  // effect only runs once the renderer exists (effect order) and on scheme
  // changes after that.
  useEffect(() => {
    applySchemeColors(graph, view, scheme);
    const renderer = sigma.current;
    if (renderer) applyChrome(renderer, graph, scheme, widthFactor);
  }, [graph, view, scheme]);

  return (
    <div
      ref={container}
      className="absolute inset-0"
      style={{ background: SCHEMES[scheme].ground }}
    />
  );
}
