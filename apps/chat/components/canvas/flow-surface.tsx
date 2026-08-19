"use client";

import {
  Background,
  Handle,
  type Node,
  type NodeProps,
  type NodeTypes,
  Position,
  ReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { ReactNode } from "react";
import { NODE_HEIGHT, NODE_WIDTH } from "@/lib/ultraplan/graph";
import type { CanvasGraph, CanvasNode } from "@/lib/ultraplan/types";
import { cn } from "@/lib/utils";

export type FlowSurfaceProps = {
  graph: CanvasGraph;
  renderNode: (node: CanvasNode) => ReactNode;
  className?: string;
};

type AdapterData = {
  node: CanvasNode;
  render: (node: CanvasNode) => ReactNode;
};

/**
 * xyflow 12's `NodeProps` is generic over the NODE, not over the node's data —
 * `NodeProps<AdapterData>` fails the `NodeType extends Node` constraint. Naming
 * the node type once here is the whole difference.
 */
type AdapterFlowNode = Node<AdapterData, CanvasNode["type"]>;

/**
 * One adapter component for all four node types: the per-type rendering is
 * already a switch inside CanvasNodeCard, and xyflow only needs to know where
 * the handles are.
 */
function AdapterNode({ data }: NodeProps<AdapterFlowNode>) {
  return (
    <>
      <Handle position={Position.Left} type="target" />
      {data.render(data.node)}
      <Handle position={Position.Right} type="source" />
    </>
  );
}

// MODULE SCOPE, not inline: xyflow re-instantiates every node when nodeTypes is
// a new object, which it warns about loudly and which resets node internals.
const nodeTypes = {
  fact: AdapterNode,
  persona: AdapterNode,
  artifact: AdapterNode,
  task: AdapterNode,
} as NodeTypes;

export function FlowSurface({
  graph,
  renderNode,
  className,
}: FlowSurfaceProps) {
  return (
    // xyflow measures its container: it needs an explicit height, not just flex-1.
    <div className={cn("relative h-full min-h-64", className)}>
      <ReactFlow
        edges={graph.edges.map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          // A `produces` edge describes work that has not happened yet.
          animated: edge.kind === "produces",
        }))}
        fitView
        nodes={graph.nodes.map((node) => ({
          id: node.id,
          type: node.type,
          position: node.position,
          data: { node, render: renderNode },
          // The SAME constants buildCanvasGraph() laid the positions out with.
          // xyflow sizes a custom node to its content unless told otherwise,
          // and content-sized cards would drift out of a grid whose lane and
          // row pitch were computed for 280x112 — a long fact value alone would
          // push one card across the next lane. Read from lib/ultraplan/graph
          // rather than retyped, so the two cannot disagree.
          style: { width: NODE_WIDTH, height: NODE_HEIGHT },
        }))}
        nodesConnectable={false}
        nodeTypes={nodeTypes}
        proOptions={{ hideAttribution: false }}
      >
        <Background />
      </ReactFlow>
    </div>
  );
}
