import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { PhaseAttemptHistory } from "@/components/project/phase-attempt-history";
import { Badge } from "@/components/ui/badge";
import { getProjectPhases } from "@/lib/db/phase-queries";
import { getProjectById } from "@/lib/db/queries";
import {
  describePhaseRoster,
  type PhaseRosterEntry,
} from "@/lib/phases/roster";
import { getRequestSession } from "@/lib/request-session";

/**
 * The project phases screen: what the eight phases ARE, where the founder is,
 * and what the gate has said about each one.
 *
 * Until this existed, no screen in the app named a single phase. The rail read
 * "Phase 3 of 8" and there was nowhere to learn what 4 through 8 were, what
 * this one required, or that the gate had already refused this phase three
 * times. `PHASES` was imported by the export builder and the sequencer and by
 * no component at all.
 *
 * Same shape as ProjectSimulationScreen — a static frame with the private half
 * behind Suspense — for the same two reasons: everything below depends on who
 * is asking, and `params` must not be awaited above the boundary or the shared
 * App Shell gets tied to one project id.
 */
export function ProjectPhasesScreen({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  return (
    <div className="flex h-[calc(100dvh_-_var(--header-height))] min-h-0 flex-col">
      <Suspense fallback={<ProjectPhasesSkeleton />}>
        <ProjectPhasesContent params={params} />
      </Suspense>
    </div>
  );
}

function ProjectPhasesSkeleton() {
  return (
    <>
      <div className="flex shrink-0 flex-wrap items-baseline gap-2 border-b px-4 py-3">
        <div className="h-5 w-40 animate-pulse rounded bg-muted" />
        <div className="h-3 w-24 animate-pulse rounded bg-muted" />
      </div>
      <div className="min-h-0 flex-1 space-y-2 p-4">
        <div className="h-16 w-full animate-pulse rounded bg-muted/40" />
        <div className="h-16 w-full animate-pulse rounded bg-muted/40" />
        <div className="h-16 w-full animate-pulse rounded bg-muted/40" />
      </div>
    </>
  );
}

const POSITION_LABEL: Record<PhaseRosterEntry["position"], string> = {
  passed: "passed",
  current: "you are here",
  later: "not started",
};

/**
 * The gate's line for one phase.
 *
 * FOUR STATES, KEPT APART. Never judged, open but unjudged, judged-and-readable,
 * and judged-but-unreadable are four different facts, and only one of them is a
 * refusal. Collapsing any pair is the inversion this whole batch exists to end.
 */
function GateLine({ entry }: { entry: PhaseRosterEntry }) {
  if (!entry.gate.assessed) {
    return (
      <p className="text-muted-foreground text-sm">
        {entry.gate.why === "no-row"
          ? "The workflow has not reached this phase yet."
          : "This phase is open. The gate has not judged it yet — which is not the same as being blocked."}
      </p>
    );
  }

  const { decision, reason, missing, criteriaAssessed, verdictReadable } =
    entry.gate;

  return (
    <div className="space-y-1">
      {reason ? <p className="text-sm">{reason}</p> : null}

      {verdictReadable && criteriaAssessed === 0 ? (
        <p className="text-muted-foreground text-sm">
          The gate could not assess this phase — no criterion was scored, so
          this is not a judgement of the work.
        </p>
      ) : null}

      {verdictReadable ? null : (
        <p className="text-muted-foreground text-sm">
          The detail of this verdict can no longer be read, so the absence of a
          list below is a reading failure rather than a clean result.
        </p>
      )}

      {verdictReadable && criteriaAssessed > 0 && missing.length > 0 ? (
        <ul className="space-y-1 pt-1">
          {missing.map((gap) => (
            <li className="flex gap-2 text-sm" key={gap}>
              <span aria-hidden="true" className="opacity-50">
                —
              </span>
              <span>{gap}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {decision === "PASS" && missing.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Every blocking criterion was met.
        </p>
      ) : null}
    </div>
  );
}

function DecisionBadge({ entry }: { entry: PhaseRosterEntry }) {
  if (!entry.gate.assessed) {
    return <Badge variant="outline">NOT ASSESSED</Badge>;
  }
  if (entry.gate.decision === "BLOCK") {
    return <Badge variant="destructive">BLOCKED</Badge>;
  }
  if (entry.gate.decision === "WARN") {
    return <Badge variant="secondary">THIN</Badge>;
  }
  return <Badge>PASSED</Badge>;
}

async function ProjectPhasesContent({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const session = await getRequestSession();
  if (!session?.user) {
    redirect("/");
  }

  const project = await getProjectById({ id: projectId });
  // "No such project" and "not yours" are the same answer on purpose.
  if (!project || project.userId !== session.user.id) {
    notFound();
  }

  const rows = await getProjectPhases({ projectId });
  const roster = describePhaseRoster(
    rows.map((row) => ({
      phaseKey: row.phaseKey,
      status: row.status,
      decision: row.decision,
      reason: row.reason,
      nextQuestion: row.nextQuestion,
      verdict: row.verdict,
      attemptCount: row.attemptCount,
    }))
  );

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-baseline gap-2 border-b px-4 py-3">
        <h1 className="font-medium text-base">{project.name}</h1>
        <span className="text-muted-foreground text-xs">Phases</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <p className="mb-4 max-w-2xl text-muted-foreground text-sm">
          Each phase has a gate. The gate reads the transcript against that
          phase's exit criteria and refuses to advance while something is
          missing — so a refusal is the product working, not a failure. Open a
          phase to read every verdict it has given.
        </p>
        <ol className="space-y-2">
          {roster.map((entry) => (
            <li
              className={
                entry.position === "current"
                  ? "rounded-lg border border-foreground/30 bg-muted/30 p-3"
                  : "rounded-lg border p-3"
              }
              key={entry.key}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground text-xs tabular-nums">
                  {entry.order}/{roster.length}
                </span>
                <span className="font-medium text-sm">{entry.title}</span>
                <DecisionBadge entry={entry} />
                <span className="text-muted-foreground text-xs">
                  {POSITION_LABEL[entry.position]}
                </span>
                <span className="text-muted-foreground text-xs">
                  {entry.criteriaCount} exit criteria
                </span>
                {/*
                  The attempt count is the number nobody could see before. A
                  phase that eventually passed after four tries refused three
                  times, and those refusals are the record of the founder
                  actually learning something.
                */}
                {entry.attemptCount > 0 ? (
                  <span className="text-muted-foreground text-xs">
                    {entry.attemptCount === 1
                      ? "1 attempt"
                      : `${entry.attemptCount} attempts`}
                  </span>
                ) : null}
              </div>

              <p className="mt-1 text-muted-foreground text-sm">{entry.goal}</p>

              <div className="mt-2">
                <GateLine entry={entry} />
              </div>

              {entry.attemptCount > 0 ? (
                <PhaseAttemptHistory
                  attemptCount={entry.attemptCount}
                  phaseKey={entry.key}
                  phaseTitle={entry.title}
                  projectId={projectId}
                />
              ) : null}
            </li>
          ))}
        </ol>
      </div>
    </>
  );
}
