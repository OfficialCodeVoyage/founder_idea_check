"use client";

import { AlertTriangleIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { LANE_ORDER } from "@/lib/ultraplan/graph";
import { summarizeTasks } from "@/lib/ultraplan/tasks";
import type {
  BlockerAnalysis,
  BlockerAnalysisState,
  CanvasGraph,
  CanvasTaskNode,
  TaskEvent,
} from "@/lib/ultraplan/types";
import { cn } from "@/lib/utils";
import { BlockerPlan } from "./blocker-plan";
import { CanvasNodeCard } from "./canvas-nodes";
import { FlowSurface } from "./flow-surface";

/**
 * The project canvas: facts, personas, artifacts and the tasks that would
 * unblock the current phase, on one surface.
 *
 * This component composes; it does not compute. Nodes, edges, positions,
 * statuses and blockers all arrive already decided from lib/ultraplan/, which
 * is unit-tested without a DOM. Data fetching is deliberately the caller's job
 * — wiring it to tRPC would mean editing routers outside this change's scope,
 * and a presentational component is testable and reusable in a way a
 * self-fetching one is not. The caller is components/project/project-canvas-screen.tsx.
 */

/**
 * FOUR states, not three.
 *
 * components/phase-rail.tsx maps only PASS/WARN/BLOCK and reaches for BLOCK
 * whenever the decision is NULL — so a project on turn 1, whose gate has never
 * run, greets the founder with a red BLOCKED badge while the phase directive is
 * telling them to just start talking. `unassessed` is a first-class state here
 * and reads as neutral, because that is what it is.
 *
 * The other three labels intentionally match the rail's wording (READY / THIN /
 * BLOCKED) so the two surfaces cannot describe the same verdict differently.
 */
const ASSESSMENT_STYLE: Record<
  BlockerAnalysisState,
  { label: string; hint: string; className: string }
> = {
  unassessed: {
    label: "NOT ASSESSED",
    hint: "The gate has not run for this phase yet. Nothing here is blocked.",
    className: "border-dashed bg-transparent text-muted-foreground",
  },
  clear: {
    label: "READY",
    hint: "Every exit criterion for this phase is met.",
    className: "bg-primary text-primary-foreground",
  },
  advisory: {
    label: "THIN",
    hint: "Advance is permitted, but gaps are outstanding.",
    className: "bg-secondary text-secondary-foreground",
  },
  blocked: {
    label: "BLOCKED",
    hint: "At least one blocking exit criterion is unmet.",
    className: "bg-destructive text-destructive-foreground",
  },
};

const LANE_LABEL: Record<(typeof LANE_ORDER)[number], string> = {
  fact: "Facts",
  persona: "Personas",
  artifact: "Artifacts",
  task: "Tasks",
};

function isTaskNode(
  node: CanvasGraph["nodes"][number]
): node is CanvasTaskNode {
  return node.type === "task";
}

function DroppedEdgeWarning({ graph }: { graph: CanvasGraph }) {
  if (graph.droppedEdges.length === 0) {
    return null;
  }
  // Shown, not swallowed. A relationship the data claimed and the canvas could
  // not draw is a defect in the data; a silently thinner graph looks correct
  // and is the harder bug to ever notice.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge className="gap-1 bg-secondary text-[10px] text-secondary-foreground">
          <AlertTriangleIcon className="size-3" />
          {graph.droppedEdges.length} unresolved link
          {graph.droppedEdges.length === 1 ? "" : "s"}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">
        <ul>
          {graph.droppedEdges.map((edge) => (
            <li key={`${edge.kind}:${edge.source}->${edge.target}`}>
              {edge.kind}: {edge.reason}
            </li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}

export type ProjectCanvasProps = {
  graph: CanvasGraph;
  analysis: BlockerAnalysis;
  /** Omit to render read-only; the task controls disappear with it. */
  onTaskEvent?: (taskId: string, event: TaskEvent) => void;
  className?: string;
};

export function ProjectCanvas({
  graph,
  analysis,
  onTaskEvent,
  className,
}: ProjectCanvasProps) {
  const assessment = ASSESSMENT_STYLE[graph.assessment];
  const taskSummary = summarizeTasks(
    graph.nodes.filter(isTaskNode).map((node) => node.task)
  );

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-muted-foreground text-xs">
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge className={cn("shrink-0", assessment.className)}>
              {assessment.label}
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm">
            {assessment.hint}
          </TooltipContent>
        </Tooltip>
        {LANE_ORDER.map((lane) => (
          <span className="shrink-0" key={lane}>
            {LANE_LABEL[lane]}{" "}
            {graph.nodes.filter((node) => node.type === lane).length}
          </span>
        ))}
        {taskSummary.unknown > 0 ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge className="border-dashed bg-transparent text-[10px] text-muted-foreground">
                {taskSummary.unknown} unreadable
              </Badge>
            </TooltipTrigger>
            <TooltipContent className="max-w-sm">
              Stored state for these tasks could not be read. They are shown as
              unknown rather than reset, so nothing is silently marked done.
            </TooltipContent>
          </Tooltip>
        ) : null}
        <DroppedEdgeWarning graph={graph} />
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 lg:flex-row">
        {graph.nodes.length === 0 ? (
          <div className="flex flex-1 items-center justify-center rounded-md border border-dashed p-8 text-center text-muted-foreground text-sm">
            Nothing on the canvas yet. Facts, personas and artifacts appear here
            as the conversation establishes them.
          </div>
        ) : (
          <FlowSurface
            className="min-h-64 flex-1 rounded-md border bg-background/40 p-3"
            graph={graph}
            renderNode={(node) => (
              <CanvasNodeCard node={node} onTaskEvent={onTaskEvent} />
            )}
          />
        )}
        <BlockerPlan
          analysis={analysis}
          className="w-full shrink-0 overflow-y-auto lg:w-80"
        />
      </div>
    </div>
  );
}
