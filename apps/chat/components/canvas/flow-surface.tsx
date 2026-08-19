"use client";

import type { ReactNode } from "react";
import { graphBounds, NODE_HEIGHT, NODE_WIDTH } from "@/lib/ultraplan/graph";
import type {
  CanvasEdge,
  CanvasGraph,
  CanvasNode,
} from "@/lib/ultraplan/types";
import { cn } from "@/lib/utils";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE @xyflow/react SEAM — AND RIGHT NOW, A STUB BEHIND IT.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Step 7 specifies `@xyflow/react` + the AI Elements `canvas` component. Neither
 * is installed, and adding them means editing apps/chat/package.json and
 * touching the shared lockfile — out of scope for this change. So this file is
 * the ONE place that knows how nodes get painted, and it currently paints them
 * itself: absolutely positioned cards in the coordinate space graph.ts already
 * computed, with an SVG layer for edges.
 *
 * WHY A SEAM AND NOT A `TODO`: without it, "we cannot install the dep yet"
 * would leak into every component — each node would grow xyflow imports, the
 * graph builder would drift toward xyflow's Node<T> shape, and swapping the
 * renderer later would be a rewrite. With it, the swap is this file plus a
 * nodeTypes map. Everything else consumes CanvasNode / CanvasEdge, which are
 * OUR types, laid out by OUR pure code — the layout, the ids and the statuses
 * are already xyflow-compatible by construction.
 *
 * WHAT THE STUB DOES NOT DO, stated plainly so nobody mistakes it for finished:
 * no panning, no zooming, no dragging, no minimap, no edge routing, no
 * virtualisation. It renders the graph, correctly and deterministically, and
 * nothing more. The exact package.json diff and the exact replacement body are
 * in CANVAS-INTEGRATION-NOTES.md at the repo root.
 */

export type FlowSurfaceProps = {
  graph: CanvasGraph;
  /**
   * Node renderer, keyed by the caller. This is the same contract xyflow's
   * `nodeTypes` map has — one component per node type — so the swap is
   * mechanical rather than a redesign.
   */
  renderNode: (node: CanvasNode) => ReactNode;
  className?: string;
};

/** Edge geometry: leave the source's right edge, enter the target's left edge. */
function edgeLine(
  edge: CanvasEdge,
  positions: Map<string, CanvasNode["position"]>
) {
  const source = positions.get(edge.source);
  const target = positions.get(edge.target);
  if (!(source && target)) {
    // buildCanvasGraph() guarantees both endpoints exist — it drops (and
    // reports) any edge whose endpoints do not resolve. Returning null here
    // rather than trusting that invariant keeps a bad graph from rendering NaN
    // coordinates, which browsers turn into an invisible, undebuggable blank.
    return null;
  }
  return {
    x1: source.x + NODE_WIDTH,
    y1: source.y + NODE_HEIGHT / 2,
    x2: target.x,
    y2: target.y + NODE_HEIGHT / 2,
  };
}

const EDGE_DASH: Record<CanvasEdge["kind"], string | undefined> = {
  cites: undefined,
  "derived-from": undefined,
  // A `produces` edge describes something that has NOT happened yet — the task
  // would establish this fact. Dashed, so a plan is never mistaken for a record.
  produces: "4 4",
  "depends-on": "2 3",
};

export function FlowSurface({
  graph,
  renderNode,
  className,
}: FlowSurfaceProps) {
  const bounds = graphBounds(graph);
  const positions = new Map(graph.nodes.map((n) => [n.id, n.position]));

  return (
    <div className={cn("relative overflow-auto", className)}>
      <div
        className="relative"
        style={{
          width: Math.max(bounds.width, 1),
          height: Math.max(bounds.height, 1),
        }}
      >
        <svg
          className="pointer-events-none absolute inset-0 text-border"
          height={bounds.height}
          width={bounds.width}
        >
          <title>Relationships between the items on this canvas</title>
          {graph.edges.map((edge) => {
            const line = edgeLine(edge, positions);
            if (!line) {
              return null;
            }
            return (
              <line
                key={edge.id}
                stroke="currentColor"
                strokeDasharray={EDGE_DASH[edge.kind]}
                strokeWidth={1.5}
                x1={line.x1}
                x2={line.x2}
                y1={line.y1}
                y2={line.y2}
              />
            );
          })}
        </svg>
        {graph.nodes.map((node) => (
          <div
            className="absolute"
            key={node.id}
            style={{
              left: node.position.x,
              top: node.position.y,
              width: NODE_WIDTH,
            }}
          >
            {renderNode(node)}
          </div>
        ))}
      </div>
    </div>
  );
}
