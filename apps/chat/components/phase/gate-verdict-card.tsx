"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { describeGateVerdict } from "@/lib/phases/rail";
import { cn } from "@/lib/utils";
import { usePhaseGate } from "./phase-gate-provider";

/**
 * THE REFUSAL, IN FULL, WHERE THE FOUNDER IS LOOKING.
 *
 * This product's claim is that the gate refuses and NAMES THE GAP. Before this
 * card, that naming reached the founder as: one gap, the first of however many,
 * inside a hover tooltip on a 36px strip — plus its indirect effect on the next
 * assistant reply. A founder blocked on three criteria saw one of them and had
 * no way to learn the rest short of opening the canvas.
 *
 * WHY IT IS NOT A MESSAGE IN THE TRANSCRIPT. It cannot be. The gate runs in
 * `after()` (app/(chat)/api/chat/route.ts), i.e. after the response has already
 * flushed — route.ts says so outright: "its verdict cannot reach the turn it
 * judged". There is no message to attach it to at the time it is written, and
 * it is not conversation history in any case: it is the CURRENT state of the
 * phase, which changes when the gate next runs. So it sits at the foot of the
 * transcript, directly above the composer, which is both where the eye already
 * is and an honest place for "here is where you stand right now".
 *
 * Every judgement lives in `describeGateVerdict` (lib/phases/rail.ts), beside
 * the rail's own `describeRail`, reading the same payload. That is deliberate:
 * these two renderers disagreed once before, and the rail spent a release
 * saying "READY / no assessment yet".
 */
const STATUS_STYLE = {
  blocked: "border-destructive/40 bg-destructive/5",
  thin: "border-amber-500/40 bg-amber-500/5",
  passed: "border-emerald-500/40 bg-emerald-500/5",
  complete: "border-emerald-500/40 bg-emerald-500/5",
} as const;

const STATUS_VARIANT = {
  blocked: "destructive",
  thin: "secondary",
  passed: "default",
  complete: "default",
} as const;

export function GateVerdictCard({
  projectId,
  className,
}: {
  projectId: string;
  className?: string;
}) {
  const gate = usePhaseGate();
  if (!gate?.data) {
    return null;
  }

  const view = describeGateVerdict({
    assessment: gate.wait.kind,
    criteriaAssessed: gate.data.criteriaAssessed,
    decision: gate.data.decision,
    missing: gate.data.missing,
    nextQuestion: gate.data.nextQuestion,
    reason: gate.data.reason,
    total: gate.data.total,
    verdictReadable: gate.data.verdictReadable,
    workflowComplete: gate.data.workflowComplete,
  });

  // NOT ASSESSED IS NOT A VERDICT, so it does not get a verdict's card. A
  // founder who has not been judged yet must not see a bordered panel that
  // looks like a ruling — the only thing worth saying is that the gate has not
  // looked, and only while something is actually pending.
  if (!view.assessed) {
    return view.pending ? (
      <output
        className={cn(
          "mx-auto block w-full px-2 pb-2 text-muted-foreground text-xs md:max-w-3xl",
          className
        )}
      >
        {view.pending.marker} — {view.note}
      </output>
    ) : null;
  }

  return (
    <output
      className={cn("mx-auto block w-full px-2 pb-2 md:max-w-3xl", className)}
    >
      <div className={cn("rounded-lg border p-3", STATUS_STYLE[view.status])}>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={STATUS_VARIANT[view.status]}>{view.label}</Badge>
          <span className="font-medium text-sm">{gate.data.title}</span>
          <span className="text-muted-foreground text-xs">
            phase {gate.data.order} of {gate.data.total}
          </span>
          {/*
            Shown at every breakpoint. It is the only signal that this card may
            be describing an EARLIER turn, and a founder reading a refusal needs
            to know whether it judged what they just said.
          */}
          {view.pending ? (
            <span className="text-xs italic opacity-70">
              {view.pending.marker}
            </span>
          ) : null}
        </div>

        {view.reason ? <p className="mt-2 text-sm">{view.reason}</p> : null}

        {/*
          THE GATE NEVER RAN. `failClosedVerdict` returns `perCriterion: []`
          and `missing: [reason]`, so listing `missing` here would tell a
          founder that one specific thing is missing when in truth nothing was
          judged and every criterion is still pending. It is a plumbing failure
          wearing a refusal's clothes, and it gets its own sentence instead.
        */}
        {view.coverage.kind === "none-scored" ? (
          <p className="mt-3 rounded border border-dashed p-2 text-sm">
            <span className="font-medium">
              The gate could not assess this phase.
            </span>{" "}
            No criterion was scored, so this is not a judgement of your work —
            nothing above tells you what to change. Send another message and it
            will try again.
          </p>
        ) : null}

        {view.coverage.kind === "unreadable" ? (
          <p className="mt-3 rounded border border-dashed p-2 text-sm">
            <span className="font-medium">
              This verdict can no longer be read.
            </span>{" "}
            The decision above was stored, but its detail no longer matches the
            shape this app expects — so the absence of a list below is a reading
            failure, not a clean bill of health.
          </p>
        ) : null}

        {view.coverage.kind === "scored" && view.gaps.length > 0 ? (
          <div className="mt-3">
            <p className="font-medium text-xs uppercase tracking-wide opacity-70">
              {view.gaps.length === 1
                ? `What is missing — 1 of ${view.coverage.criteria} criteria`
                : `What is missing — ${view.gaps.length} of ${view.coverage.criteria} criteria`}
            </p>
            <ul className="mt-1 space-y-1">
              {/*
                EVERY gap, not `missing.at(0)`. The rail shows one because it
                has one line; this is the surface that exists so the rest are
                not invisible.

                Keyed by the gap text: `missing` is a set of distinct criterion
                descriptions from one verdict, so duplicates would themselves be
                a defect worth seeing rather than a key to paper over.
              */}
              {view.gaps.map((gap) => (
                <li className="flex gap-2 text-sm" key={gap}>
                  <span aria-hidden="true" className="opacity-50">
                    —
                  </span>
                  <span>{gap}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {view.coverage.kind === "scored" && view.noGapNote ? (
          <p className="mt-2 text-muted-foreground text-sm">{view.noGapNote}</p>
        ) : null}

        {view.nextQuestion ? (
          <p className="mt-3 border-t pt-2 text-sm">
            <span className="font-medium">Next: </span>
            {view.nextQuestion}
          </p>
        ) : null}

        <div className="mt-2 flex gap-3 text-xs">
          <Link
            className="underline underline-offset-2 opacity-70 hover:opacity-100"
            href={`/project/${projectId}/phases`}
          >
            All phases and past verdicts
          </Link>
          <Link
            className="underline underline-offset-2 opacity-70 hover:opacity-100"
            href={`/project/${projectId}/canvas`}
          >
            Canvas
          </Link>
        </div>
      </div>
    </output>
  );
}
