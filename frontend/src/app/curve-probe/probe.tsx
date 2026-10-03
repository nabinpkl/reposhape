"use client";

import Sigma from "sigma";
import Graph from "graphology";
import { useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";

import {
  CurvedArrowProgram,
  EdgeCurvedLineProgram,
} from "@/features/graph/curvedEdgeProgram";
import type {
  EdgeAttributes,
  NodeAttributes,
} from "@/features/graph/graphModel";

/**
 * Minimal curved-edge probe, served at /curve-probe?case=<n> during
 * development. One scene per case so each program path is read alone:
 * 0 = single line edge, 1 = single arrow edge, 2 = mutual pair,
 * 3 = self-loop, 4 = single arrow alone, 5 = same-direction pair,
 * 6 = single reversed line edge.
 */
export function CurveProbe() {
  const container = useRef<HTMLDivElement>(null);
  const params = useSearchParams();
  const which = params.get("case") ?? "0";

  useEffect(() => {
    if (!container.current) return;
    const graph = new Graph<NodeAttributes, EdgeAttributes>({
      type: "directed",
      multi: true,
    });
    const node = (label: string, x: number, y: number): NodeAttributes => ({
      label,
      x,
      y,
      size: 14,
      color: "#ffffff",
      cluster: 0,
      inDegree: 0,
      outDegree: 0,
      lines: 0,
      fullPath: label,
    });
    graph.addNode("a", node("a", 0, 0));
    graph.addNode("b", node("b", 10, 0));
    const red: EdgeAttributes = { size: 3, color: "#ff0000", typeOnly: false, runtime: false };
    const green: EdgeAttributes = { size: 3, color: "#00ff00", typeOnly: false, runtime: false };
    const white: EdgeAttributes = { size: 3, color: "#e2e2f5", typeOnly: false, runtime: false };
    if (which === "0") {
      graph.addDirectedEdge("a", "b", red);
    } else if (which === "1") {
      graph.addDirectedEdge("a", "b", { ...white, type: "arrow" } as EdgeAttributes);
    } else if (which === "2") {
      graph.addDirectedEdge("a", "b", red);
      graph.addDirectedEdge("b", "a", green);
    } else if (which === "4") {
      graph.addDirectedEdge("a", "b", { ...white, size: 8, type: "arrow" } as EdgeAttributes);
    } else if (which === "5") {
      graph.addDirectedEdge("a", "b", red);
      graph.addDirectedEdge("a", "b", green);
    } else if (which === "6") {
      graph.addDirectedEdge("b", "a", green);
    } else {
      graph.addDirectedEdge("a", "a", { size: 3, color: "#ffff00", typeOnly: false, runtime: false });
    }
    const renderer = new Sigma(graph, container.current, {
      defaultEdgeType: "line",
      ...(params.get("stock") === "1"
        ? {}
        : {
            edgeProgramClasses: {
              line: EdgeCurvedLineProgram,
              arrow: CurvedArrowProgram,
            },
          }),
    });
    renderer.on("clickNode", ({ node }) => {
      document.title = `picked:${node}`;
    });
    renderer.on("clickStage", () => {
      document.title = "picked:stage";
    });
    renderer.on("clickEdge", ({ edge }) => {
      document.title = `picked:edge:${edge}`;
    });
    // ?reducer=arrow exercises the app's own path: per-frame type switch
    // through edgeReducer (what focus does) rather than a graph attribute.
    if (params.get("reducer") === "arrow") {
      renderer.setSetting("edgeReducer", (_edge, data) => ({
        ...data,
        color: "#e2e2f5",
        size: 3,
        type: "arrow",
      }));
      renderer.refresh();
    }
    return () => {
      document.title = "curve-probe";
      renderer.kill();
    };
  }, [which, params]);

  return (
    <div
      ref={container}
      style={{ width: 800, height: 600, background: "#0a0a14" }}
    />
  );
}
