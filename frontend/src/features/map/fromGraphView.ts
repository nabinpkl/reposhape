import type { FolderData } from "reposhape-viewer";

import type { GraphView } from "@/generated/contracts";

/**
 * A repo's view as the viewer's data: its files, line counts, import clusters
 * and imports.
 *
 * A file with no imports either way is the backend's trailing "(no imports)"
 * bucket, which is an absence of community rather than a community, so it
 * gets no group. The size floor is seventy lines: below that a short module
 * is a speck beside a three-thousand-line one.
 */
export function fromGraphView(view: GraphView): FolderData {
  return {
    files: view.nodes.map((node) => ({
      path: node.path,
      size: node.lines,
      group: node.in_degree + node.out_degree === 0 ? null : String(node.cluster),
    })),
    groups: view.clusters.map((cluster) => ({
      id: String(cluster.id),
      label: cluster.label,
      color: cluster.color,
    })),
    links: view.edges,
    sizeLabel: "lines",
    sizeFloor: 70,
  };
}
