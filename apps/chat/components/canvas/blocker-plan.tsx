"use client";

import { Badge } from "@/components/ui/badge";
import type {
  Blocker,
  BlockerAnalysis,
  BlockerSeverity,
} from "@/lib/ultraplan/types";
import { cn } from "@/lib/utils";

/**
 * The Ultraplan panel: what is standing in the way, and the concrete moves that
 * would clear it.
 *
 * Step 7 specifies AI Elements' `plan` + `chain-of-thought` for this. Neither is
 * installed (they arrive with `npx ai-elements@latest add plan chain-of-thought`,
 * which writes into components/ai-elements/ and edits package.json), so this
 * renders the same two ideas with the shadcn primitives already in the repo:
 * the gate's own reason as the reasoning trace, and each blocker's unblocking
 * tasks as an ordered plan. CANVAS-INTEGRATION-NOTES.md has the swap.
 *
 * There is NO logic here. Which blockers exist, how severe they are and what
 * closes them is decided by lib/ultraplan/blockers.ts, under test.
 */

/**
 * Severity → affordance. `unknown` must not look like `blocking` and must not
 * look like "fine": it is drawn as absence (dashed, muted), because the honest
 * message is "the gate could not read this", not "this failed".
 */
const SEVERITY_STYLE: Record<
  BlockerSeverity,
  { label: string; className: string }
> = {
  blocking: {
    label: "Blocking",
    className: "bg-destructive text-destructive-foreground",
  },
  unknown: {
    label: "Not assessed",
    className: "border-dashed bg-transparent text-muted-foreground",
  },
  advisory: {
    label: "Advisory",
    className: "bg-secondary text-secondary-foreground",
  },
};

function BlockerRow({ blocker }: { blocker: Blocker }) {
  const style = SEVERITY_STYLE[blocker.severity];
  return (
    <li className="rounded-md border p-3">
      <div className="flex items-start gap-2">
        <Badge className={cn("mt-0.5 shrink-0 text-[10px]", style.className)}>
          {style.label}
        </Badge>
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-snug">{blocker.blocker}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {blocker.criterionId}
            {/* Severity and "does this stop me?" are separate facts, and the
                panel says both — an advisory gap under a BLOCK verdict is real
                but is not what is holding the phase. */}
            {blocker.blocksAdvance ? " · blocks this phase" : ""}
          </p>
        </div>
      </div>
      {blocker.unblockingTasks.length > 0 ? (
        <ol className="mt-2 space-y-1 pl-4">
          {blocker.unblockingTasks.map((task) => (
            <li
              className="list-decimal text-muted-foreground text-xs"
              key={task.id}
            >
              <span className="text-foreground">{task.title}</span>
              {task.detail ? <span> — {task.detail}</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
    </li>
  );
}

export function BlockerPlan({
  analysis,
  className,
}: {
  analysis: BlockerAnalysis;
  className?: string;
}) {
  // THE BRANCH THIS COMPONENT EXISTS FOR. A project whose gate has never run is
  // not blocked and has no plan — telling it there is one would invent gaps
  // nobody found, on turn 1, while the phase prompt is asking the founder to
  // just start talking.
  if (analysis.state === "unassessed") {
    return (
      <div
        className={cn(
          "rounded-md border border-dashed p-3 text-muted-foreground text-xs",
          className
        )}
      >
        <p className="font-medium text-foreground text-sm">Not assessed yet</p>
        <p className="mt-1">
          The gate has not run for this phase. Nothing is blocked — keep
          describing the problem and it will assess as you go.
        </p>
      </div>
    );
  }

  if (analysis.blockers.length === 0) {
    return (
      <div className={cn("rounded-md border p-3", className)}>
        <p className="font-medium text-sm">Nothing outstanding</p>
        {analysis.reason ? (
          <p className="mt-1 text-muted-foreground text-xs">
            {analysis.reason}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className={cn("space-y-2", className)}>
      {analysis.reason ? (
        // The gate's own sentence, passed through verbatim rather than
        // paraphrased. A recomputed summary is a second opinion that can
        // disagree with the verdict the founder is actually being held to.
        <p className="text-muted-foreground text-xs">{analysis.reason}</p>
      ) : null}
      <ol className="space-y-2">
        {analysis.blockers.map((blocker) => (
          <BlockerRow blocker={blocker} key={blocker.id} />
        ))}
      </ol>
    </div>
  );
}
