"use client";

import Link from "next/link";
import { HandoffExportDialog } from "@/components/export/handoff-export-dialog";
import { usePhaseGate } from "@/components/phase/phase-gate-provider";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { describeRail, type RailStatus } from "@/lib/phases/rail";
import { cn } from "@/lib/utils";

const PERCENT = 100;

/**
 * Every judgement about WHAT the rail says lives in `describeRail`
 * (lib/phases/rail.ts). This map is presentation only.
 *
 * Neutral outline for `unassessed`: "we have not looked yet" is not a failure.
 */
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
}: {
  className?: string;
  projectId: string;
}) {
  // The query and the wait live in PhaseGateProvider so this and
  // GateVerdictCard cannot disagree about whether a verdict has landed. The
  // `isStreaming` edge-trigger moved with them — see that file for why the
  // wait is edge-triggered rather than timed.
  const gate = usePhaseGate();
  const data = gate?.data ?? null;
  const wait = gate?.wait ?? { kind: "idle" as const };

  if (!data) {
    return null;
  }

  // `describeRail` shows `missing.at(0)` and that is still right HERE: this is
  // one line of a 36px strip. The rest of the gaps are no longer lost — they
  // are in GateVerdictCard, which reads this same payload through the same
  // provider.
  const rail = describeRail({
    assessment: wait.kind,
    decision: data.decision,
    missing: data.missing,
    total: data.total,
    workflowComplete: data.workflowComplete,
  });

  return (
    <div
      className={cn(
        // TWO ROWS BELOW `sm`, ONE ABOVE — and the height is owned HERE and
        // mirrored in `MainChatPanel`'s `contentHeight`, which subtracts it
        // (`3.5rem` / `2.25rem`). At 390px wide the single 36px row left the
        // detail ~20px between the badge and the two links on the right, and it
        // rendered as "f…": truncated to nothing, with no tooltip on a touch
        // screen. Phone width has room for the phase, the badge and the two
        // links on row one, and then the detail gets the whole second row.
        "flex h-14 flex-wrap content-center items-center gap-x-3 gap-y-0.5 border-b px-4 text-muted-foreground text-xs sm:h-9 sm:flex-nowrap",
        className
      )}
    >
      {/*
        "Phase 3 of 8" is the one string a founder already reads, so it is the
        door to the screen that says what the eight phases ARE. Before that
        screen existed, this number was the whole of what the app told them.
      */}
      <Link
        className="shrink-0 font-medium text-foreground hover:underline"
        href={`/project/${projectId}/phases`}
      >
        Phase {data.order} of {data.total}
      </Link>
      <Progress
        className="hidden h-1 w-24 shrink-0 sm:block"
        value={(data.order / data.total) * PERCENT}
      />
      <Badge variant={STATUS_VARIANT[rail.status]}>{rail.label}</Badge>
      {/*
        The detail and the pending marker travel together. Below `sm` they are
        the whole second row (`order-last` puts them after the links in DOM
        order, `basis-full` makes the row); from `sm` up they are back between
        the badge and the links, where they have always been.
      */}
      <div className="order-last flex min-w-0 basis-full items-center gap-3 sm:order-none sm:basis-auto">
        {/*
          A DISCLOSURE, NOT A TOOLTIP. The detail is the gate's first named gap
          and it is as long as the gate wrote it, so on a 36px strip it is
          ellipsized at most widths: below `sm` it gets a row of its own and
          still runs out at 390px, and between 640px and 767px it shares the
          row with the progress bar and two links. It used to be completed in
          a hover tooltip, which a touch screen never opens and a keyboard
          user could not focus. A button opens a popover on tap, Enter and
          Space, so the whole sentence is reachable at any width without giving
          the strip a variable height (`MainChatPanel`'s `contentHeight`
          subtracts it). The full detail is also the button's accessible name,
          whatever the ellipsis hides.
        */}
        <Popover>
          <PopoverTrigger asChild>
            <button
              className="min-w-0 cursor-pointer rounded px-1 py-0.5 text-left hover:bg-accent hover:text-accent-foreground"
              type="button"
            >
              <span className="block truncate">{rail.detail}</span>
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-[min(24rem,calc(100vw-2rem))] text-xs"
          >
            <p className="font-medium">{rail.detail}</p>
            {data.reason && data.reason !== rail.detail ? (
              <p className="mt-1 text-muted-foreground">{data.reason}</p>
            ) : null}
            {data.nextQuestion ? (
              <p className="mt-1 text-muted-foreground">
                Next: {data.nextQuestion}
              </p>
            ) : null}
            {rail.pending ? (
              <p className="mt-1 text-muted-foreground">{rail.pending.note}</p>
            ) : null}
          </PopoverContent>
        </Popover>
        {/*
          Shown at EVERY breakpoint, deliberately. It is the only signal that
          the badge may describe an earlier turn that does not need the
          disclosure above to be opened first.
        */}
        {rail.pending ? (
          <span aria-live="polite" className="shrink-0 italic">
            {rail.pending.marker}
          </span>
        ) : null}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Link
          className="rounded px-2 py-1 hover:bg-accent hover:text-accent-foreground"
          href={`/project/${projectId}/canvas`}
        >
          Canvas
        </Link>
        {/*
          The export entry point. It sits next
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
