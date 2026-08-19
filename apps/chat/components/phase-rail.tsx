"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useTRPC } from "@/trpc/react";

const PERCENT = 100;

const DECISION_LABEL = {
  PASS: "READY",
  WARN: "THIN",
  BLOCK: "BLOCKED",
} as const;

const DECISION_VARIANT = {
  PASS: "default",
  WARN: "secondary",
  BLOCK: "destructive",
} as const;

export function PhaseRail({
  className,
  projectId,
  refreshKey,
}: {
  className?: string;
  projectId: string;
  /** Message count. Changing it re-fetches — the gate runs after each turn. */
  refreshKey: number;
}) {
  const trpc = useTRPC();
  const { data, refetch } = useQuery(
    trpc.phase.getState.queryOptions({ projectId })
  );

  // refreshKey is the message count, which changes when the assistant
  // PLACEHOLDER is created — i.e. at stream START. The gate verdict, however,
  // is written in the route's after() hook, which runs once the response has
  // already flushed. A single refetch here therefore always reads the PREVIOUS
  // turn's verdict, and the rail sits one turn behind the answer on screen.
  //
  // after() has no client-visible completion signal, so poll a bounded ladder
  // instead of guessing one delay: immediately (cheap, occasionally wins), then
  // at 1.5s / 4s / 8s. Each tick is one indexed read keyed by projectId. The
  // schedule is bounded and cleared on unmount, so it cannot leak or spin.
  const lastRefreshKey = useRef(refreshKey);
  useEffect(() => {
    if (lastRefreshKey.current === refreshKey) {
      return;
    }
    lastRefreshKey.current = refreshKey;

    refetch();
    const timers = [1500, 4000, 8000].map((ms) =>
      setTimeout(() => refetch(), ms)
    );
    return () => {
      for (const t of timers) {
        clearTimeout(t);
      }
    };
  }, [refetch, refreshKey]);

  if (!data) {
    return null;
  }

  const decision = data.decision ?? "BLOCK";
  const gap = data.missing.at(0) ?? "no assessment yet — keep going";

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
      <Badge variant={DECISION_VARIANT[decision]}>
        {DECISION_LABEL[decision]}
      </Badge>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="truncate">{gap}</span>
        </TooltipTrigger>
        <TooltipContent className="max-w-sm">
          <p className="font-medium">
            {data.reason ?? "The gate has not run yet."}
          </p>
          {data.nextQuestion ? (
            <p className="mt-1 opacity-80">Next: {data.nextQuestion}</p>
          ) : null}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
