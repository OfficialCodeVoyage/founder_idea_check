"use client";

import {
  FileTextIcon,
  ListChecksIcon,
  type LucideIcon,
  TagIcon,
  UserRoundIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { availableTaskEvents } from "@/lib/ultraplan/tasks";
import type {
  CanvasNode,
  CanvasNodeStatus,
  CanvasNodeType,
  CanvasTask,
  TaskEvent,
  TaskState,
} from "@/lib/ultraplan/types";
import { cn } from "@/lib/utils";

/**
 * Node renderers. All presentation, no graph logic: positions, statuses and
 * edges are decided in lib/ultraplan/graph.ts, which is testable without a DOM.
 * If you find yourself deriving state here, it belongs there.
 */

/**
 * THE RENDERING THAT MATTERS MOST IS `unknown` vs `at-risk`.
 *
 * These are different facts about the world — "we could not determine this" and
 * "we determined this is failing" — and they get different affordances: a
 * dashed, muted outline that reads as absence, versus a solid destructive fill
 * that reads as alarm. Collapsing them would paint a project whose gate has
 * never run in the same red as one the gate actually refused. The rail keeps the
 * same five states apart in `describeRail` (lib/phases/rail.ts).
 *
 * Note also what is NOT here: no status renders as a plain checkmark. Only
 * `confirmed` gets the affirmative variant, and nothing reaches `confirmed`
 * without evidence (see graph.ts).
 */
const STATUS_STYLE: Record<
  CanvasNodeStatus,
  { label: string; className: string; badge: string }
> = {
  unknown: {
    label: "Unknown",
    className: "border-dashed border-muted-foreground/40 bg-muted/30",
    badge: "border-dashed bg-transparent text-muted-foreground",
  },
  provisional: {
    label: "Provisional",
    className: "border-border bg-card",
    badge: "bg-secondary text-secondary-foreground",
  },
  confirmed: {
    label: "Evidenced",
    className: "border-border bg-card",
    badge: "bg-primary text-primary-foreground",
  },
  "at-risk": {
    label: "At risk",
    className: "border-destructive/60 bg-card",
    badge: "bg-destructive text-destructive-foreground",
  },
};

const TYPE_ICON: Record<CanvasNodeType, LucideIcon> = {
  fact: TagIcon,
  persona: UserRoundIcon,
  artifact: FileTextIcon,
  task: ListChecksIcon,
};

const TYPE_LABEL: Record<CanvasNodeType, string> = {
  fact: "Fact",
  persona: "Persona",
  artifact: "Artifact",
  task: "Task",
};

/** Founder-facing wording for the task machine's states. */
const TASK_STATE_LABEL: Record<TaskState, string> = {
  // "Unreadable", not "New": the state is a parse failure, and calling it
  // anything friendlier hides a data problem behind a tidy label.
  unknown: "Unreadable",
  todo: "To do",
  active: "In progress",
  blocked: "Blocked",
  done: "Done",
  dropped: "Not applicable",
};

const TASK_EVENT_LABEL: Record<TaskEvent, string> = {
  start: "Start",
  block: "Blocked",
  unblock: "Unblock",
  complete: "Mark done",
  reopen: "Reopen",
  drop: "Not applicable",
  restore: "Restore",
};

function NodeShell({
  node,
  children,
}: {
  node: CanvasNode;
  children?: ReactNode;
}) {
  const style = STATUS_STYLE[node.status];
  const Icon = TYPE_ICON[node.type];
  return (
    <div
      className={cn(
        "flex h-full flex-col gap-1.5 rounded-lg border p-3 shadow-sm",
        style.className
      )}
      data-node-status={node.status}
      data-node-type={node.type}
    >
      <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
        <Icon className="size-3.5 shrink-0" />
        <span className="shrink-0">{TYPE_LABEL[node.type]}</span>
        <Badge className={cn("ml-auto shrink-0 text-[10px]", style.badge)}>
          {style.label}
        </Badge>
      </div>
      <p className="line-clamp-2 font-medium text-sm leading-snug">
        {node.title}
      </p>
      {node.subtitle ? (
        <p className="line-clamp-2 text-muted-foreground text-xs leading-snug">
          {node.subtitle}
        </p>
      ) : null}
      {children}
    </div>
  );
}

function FactFooter({ confidence }: { confidence: number | null }) {
  // NULL is rendered as words, never as "0" or an empty bar — a confidence we
  // could not read is not a low confidence.
  return (
    <p className="mt-auto text-[11px] text-muted-foreground">
      {confidence === null
        ? "confidence unavailable"
        : `confidence ${confidence}`}
    </p>
  );
}

function PersonaFooter({ evidenceCount }: { evidenceCount: number | null }) {
  if (evidenceCount === null) {
    return (
      <p className="mt-auto text-[11px] text-muted-foreground">
        evidence unavailable
      </p>
    );
  }
  return (
    <p
      className={cn(
        "mt-auto text-[11px]",
        evidenceCount === 0 ? "text-destructive" : "text-muted-foreground"
      )}
    >
      {evidenceCount === 0
        ? "no evidence — this persona is unsourced"
        : `${evidenceCount} evidence entries`}
    </p>
  );
}

export type TaskNodeProps = {
  task: CanvasTask;
  onTaskEvent?: (taskId: string, event: TaskEvent) => void;
};

function TaskFooter({ task, onTaskEvent }: TaskNodeProps) {
  // The button list comes from the state machine, not from a hand-written
  // switch here — that is what stops the UI offering "Mark done" on a blocked
  // task and then refusing the click.
  const events = availableTaskEvents(task.state);
  return (
    <div className="mt-auto flex flex-wrap items-center gap-1">
      <span className="mr-auto text-[11px] text-muted-foreground">
        {TASK_STATE_LABEL[task.state]}
      </span>
      {task.orphaned ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge className="border-dashed bg-transparent text-[10px] text-muted-foreground">
              stale
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            The latest gate verdict no longer mentions this gap. That is not the
            same as the gap being closed, so the task is kept rather than
            completed for you.
          </TooltipContent>
        </Tooltip>
      ) : null}
      {onTaskEvent
        ? events.map((event) => (
            <Button
              className="h-6 px-2 text-[11px]"
              key={event}
              onClick={() => onTaskEvent(task.id, event)}
              size="sm"
              type="button"
              variant="outline"
            >
              {TASK_EVENT_LABEL[event]}
            </Button>
          ))
        : null}
    </div>
  );
}

export function CanvasNodeCard({
  node,
  onTaskEvent,
}: {
  node: CanvasNode;
  onTaskEvent?: (taskId: string, event: TaskEvent) => void;
}) {
  switch (node.type) {
    case "fact":
      return (
        <NodeShell node={node}>
          <FactFooter confidence={node.confidence} />
        </NodeShell>
      );
    case "persona":
      return (
        <NodeShell node={node}>
          <PersonaFooter evidenceCount={node.evidenceCount} />
        </NodeShell>
      );
    case "artifact":
      return <NodeShell node={node} />;
    default:
      return (
        <NodeShell node={node}>
          <TaskFooter onTaskEvent={onTaskEvent} task={node.task} />
        </NodeShell>
      );
  }
}
