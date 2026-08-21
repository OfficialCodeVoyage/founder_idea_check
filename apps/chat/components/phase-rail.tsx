"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { HandoffExportDialog } from "@/components/export/handoff-export-dialog";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  advanceRailWait,
  describeRail,
  RAIL_POLL_CEILING_MS,
  RAIL_POLL_INTERVAL_MS,
  type RailStatus,
  type RailWait,
} from "@/lib/phases/rail";
import { cn } from "@/lib/utils";
import { useTRPC } from "@/trpc/react";

const PERCENT = 100;

/** Slow recovery poll once the wait has already timed out. */
const SLOW_POLL_MS = 15_000;

/**
 * Every judgement about WHAT the rail says lives in `describeRail`
 * (lib/phases/rail.ts). This map is presentation only.
 *
 * Neutral outline for `unassessed`: "we have not looked yet" is not a failure.
 */
/**
 * Poll only while a verdict is outstanding. Keep polling — slowly — after the
 * ceiling, so recovering from a stale "no verdict" note does not depend on the
 * window regaining focus.
 */
function pollInterval(kind: RailWait["kind"]): number | false {
  if (kind === "waiting") {
    return RAIL_POLL_INTERVAL_MS;
  }
  if (kind === "unreported") {
    return SLOW_POLL_MS;
  }
  return false;
}

const STATUS_VARIANT: Record<
  RailStatus,
  "outline" | "default" | "secondary" | "destructive"
> = {
  unassessed: "outline",
  blocked: "destructive",
  thin: "secondary",
  passed: "default",
  complete: "default",
};

export function PhaseRail({
  className,
  projectId,
  isStreaming,
}: {
  className?: string;
  projectId: string;
  /** True while the assistant is answering. The gate runs AFTER that. */
  isStreaming: boolean;
}) {
  const trpc = useTRPC();
  const [wait, setWait] = useState<RailWait>({ kind: "idle" });
  const { data } = useQuery({
    ...trpc.phase.getState.queryOptions({ projectId }),
    // Poll only while a verdict is outstanding. Keep polling — slowly — after
    // the ceiling, so recovery from a stale "no verdict" note does not depend
    // on the window regaining focus.
    refetchInterval: pollInterval(wait.kind),
    refetchIntervalInBackground: true,
  });

  // The OLD trigger was the message count, which changes when the assistant
  // placeholder is created — i.e. at stream START — while the verdict is
  // written by runPostTurnPhasePass inside after(), 15-30s after the stream
  // ENDS. The old 0/1.5/4/8s ladder therefore always expired first and the
  // rail sat a whole turn behind the answer on screen.
  //
  // Now the wait is edge-triggered on the stream ending and cleared by
  // `assessmentCount` actually CHANGING, so it tracks the event rather than
  // guessing a delay.
  // Held in a ref so the turn-ended effect can seed its baseline without
  // taking `data` as a dependency — re-running it on every poll would restart
  // the ceiling timer each tick and the wait would never expire.
  const countRef = useRef<number | null>(null);
  const wasStreaming = useRef(isStreaming);
  useEffect(() => {
    const ended = wasStreaming.current && !isStreaming;
    wasStreaming.current = isStreaming;
    if (isStreaming) {
      setWait((w) => advanceRailWait(w, { type: "turn-started" }));
      return;
    }
    if (!ended) {
      return;
    }
    setWait((w) =>
      advanceRailWait(w, { type: "turn-ended", count: countRef.current })
    );
    const ceiling = setTimeout(
      () => setWait((w) => advanceRailWait(w, { type: "ceiling-reached" })),
      RAIL_POLL_CEILING_MS
    );
    return () => clearTimeout(ceiling);
  }, [isStreaming]);

  const observed = data?.assessmentCount ?? null;
  useEffect(() => {
    countRef.current = observed;
    setWait((w) => advanceRailWait(w, { type: "state-read", count: observed }));
  }, [observed]);

  if (!data) {
    return null;
  }

  const rail = describeRail({
    decision: data.decision,
    missing: data.missing,
    workflowComplete: data.workflowComplete,
    total: data.total,
    assessment: wait.kind,
  });

  return (
    <div
      className={cn(
        "flex items-center gap-3 border-b px-4 text-muted-foreground text-xs",
        className
      )}
    >
      <span className="shrink-0 font-medium text-foreground">
        Phase {data.order} of {data.total}
      </span>
      <Progress
        className="hidden h-1 w-24 shrink-0 sm:block"
        value={(data.order / data.total) * PERCENT}
      />
      <Badge variant={STATUS_VARIANT[rail.status]}>{rail.label}</Badge>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="truncate">{rail.detail}</span>
        </TooltipTrigger>
        <TooltipContent className="max-w-sm">
          <p className="font-medium">
            {data.reason ?? "The gate has not run yet."}
          </p>
          {data.nextQuestion ? (
            <p className="mt-1 opacity-80">Next: {data.nextQuestion}</p>
          ) : null}
          {rail.pending ? (
            <p className="mt-1 opacity-80">{rail.pending.note}</p>
          ) : null}
        </TooltipContent>
      </Tooltip>
      {/*
        Shown at EVERY breakpoint, deliberately. It is the only non-hover signal
        that the badge may describe an earlier turn, and a touch device never
        opens the tooltip that explains it.
      */}
      {rail.pending ? (
        <span aria-live="polite" className="shrink-0 italic opacity-70">
          {rail.pending.marker}
        </span>
      ) : null}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Link
          className="rounded px-2 py-1 hover:bg-accent hover:text-accent-foreground"
          href={`/project/${projectId}/canvas`}
        >
          Canvas
        </Link>
        {/*
          The export entry point (EXPORT-INTEGRATION-NOTES.md §4d). It sits next
          to the phase badge on purpose and is NOT conditioned on `decision`,
          `workflowComplete` or export readiness: a founder who stops at phase 4
          still walks away with an honest repo, and the documents themselves say
          what is missing.
        */}
        <HandoffExportDialog projectId={projectId} />
      </div>
    </div>
  );
}
