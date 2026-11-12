"use client";

import { FlaskConical, Loader2 } from "lucide-react";
import { useState, useTransition } from "react";
import {
  type RunSimulationResult,
  runProjectSimulation,
} from "@/app/actions/run-simulation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { SimulationRun } from "@/lib/db/schema";
import {
  describeSeedGap,
  type SimulationSeedGap,
} from "@/lib/personas/simulation-gaps";
import {
  type DivergenceReport,
  type PersonaReaction,
  SIMULATION_NEVER_STARTED_KINDS,
} from "@/lib/research/simulation";

/**
 * Run a simulation, then read what it actually said.
 *
 * A SIMULATION IS NOT DEMAND EVIDENCE, and the UI says so on every result
 * rather than in a footnote. `judgeSimulation` returns `usableAsEvidence` as a
 * hard `false`; synthetic agents reacting to a pitch tell a founder which
 * objections to go ask real people about, and nothing more. Rendering a
 * divergence score without that sentence would invite exactly the reading the
 * verdict refuses.
 */

/**
 * Sidecar failure kinds that mean the run HAPPENED and returned nothing, as
 * opposed to never having started. `judgeSimulation` produces both names.
 */
const RAN_BUT_EMPTY = new Set(["no-reactions", "too-few-reactions"]);

/**
 * What the panel says about a failed run, in the three cases the action
 * distinguishes. Which kinds are always free is
 * `SIMULATION_NEVER_STARTED_KINDS`, the same set `simulationReachedModel`
 * waives by, so the sentence about credits cannot drift from the charge. A
 * run that came back empty is refunded only when every agent call failed, so
 * its sentence says nothing about credits.
 */
function describeFailure(kind: string): {
  headline: string;
  ran: boolean;
  record: string;
} {
  if (RAN_BUT_EMPTY.has(kind)) {
    return {
      headline:
        "The simulation ran and came back empty — this is NOT a verdict.",
      ran: true,
      record:
        "kept in the run history as not assessed, because a run that produced nothing is not a finding about your personas.",
    };
  }
  if (SIMULATION_NEVER_STARTED_KINDS.has(kind)) {
    return {
      headline: "The simulation did not run.",
      ran: false,
      record:
        "nothing was recorded or charged, because it stopped before any persona was called.",
    };
  }
  return {
    headline: "The simulation failed before it could report a result.",
    ran: false,
    record:
      "nothing was recorded, but personas may already have been called before it stopped, so the run was charged.",
  };
}

/** One gap per persona or per seat, so the identifier is the stable half. */
function gapKey(gap: SimulationSeedGap): string {
  return gap.kind === "orphan-profile" ? gap.profileId : gap.personaDocumentId;
}

function scorePercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function DivergenceBar({ divergence }: { divergence: DivergenceReport }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground text-xs">
      <span>
        divergence{" "}
        <span className="font-medium text-foreground">
          {divergence.score.toFixed(3)}
        </span>
      </span>
      <span>
        {divergence.distinctReactions} distinct of {divergence.totalReactions}
      </span>
      <span>sentiment spread {divergence.sentimentSpread.toFixed(2)}</span>
      <span>duplicates {scorePercent(divergence.duplicateRate)}</span>
    </div>
  );
}

function ReactionList({ reactions }: { reactions: PersonaReaction[] }) {
  if (reactions.length === 0) {
    return null;
  }
  return (
    <ul className="mt-3 space-y-2">
      {/*
        A completed run's reactions are a frozen snapshot — never reordered,
        filtered or appended to — and one persona legitimately reacts more than
        once with identical wording, which is exactly what duplicateRate
        measures. Index is the only genuinely unique key available; a content
        hash would collide on the duplicates this feature exists to surface.
      */}
      {reactions.map((reaction, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: frozen snapshot, and duplicate wording is the finding
        <li className="rounded-md border p-2 text-sm" key={index}>
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-medium text-xs">{reaction.username}</span>
            <span className="text-muted-foreground text-xs">
              sentiment {reaction.sentiment.toFixed(2)}
            </span>
          </div>
          <p className="mt-1 text-muted-foreground">{reaction.text}</p>
        </li>
      ))}
    </ul>
  );
}

function OutcomePanel({ result }: { result: RunSimulationResult }) {
  if (result.status === "unauthorized") {
    return <p className="text-destructive text-sm">Sign in to run this.</p>;
  }
  if (result.status === "not-found") {
    return <p className="text-destructive text-sm">Project not found.</p>;
  }
  if (result.status === "insufficient-credits") {
    return (
      <p className="text-destructive text-sm">
        You are out of credits, so the simulation did not run.
      </p>
    );
  }
  if (result.status === "no-personas" || result.status === "invalid") {
    return (
      <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
        {result.detail}
      </div>
    );
  }
  if (result.status === "profile-incomplete") {
    // The Run button stays enabled. The refusal NAMES the gap, which is the
    // posture everywhere else in this product; a disabled button with no
    // explanation is the silent version of the same answer.
    return (
      <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
        <p className="font-medium">
          The simulation did not run — nothing was recorded, because nothing
          happened.
        </p>
        <ul className="mt-2 space-y-1 text-muted-foreground">
          {result.gaps.map((gap) => (
            <li key={`${gap.kind}:${gapKey(gap)}`}>{describeSeedGap(gap)}</li>
          ))}
        </ul>
      </div>
    );
  }

  const { outcome } = result;
  if (!outcome.ok) {
    // "It never started", "it ran and came back empty" and "it failed part
    // way" are different facts and get different sentences. Telling a founder
    // "nothing happened" about a run in which every agent was called and every
    // call failed would be the same substitution as the COLLAPSED badge,
    // pointing the other way.
    const failure = describeFailure(outcome.kind);
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
        <p className="font-medium">{failure.headline}</p>
        <p className="mt-1 text-muted-foreground">{outcome.detail}</p>
        {failure.ran && typeof outcome.agentErrors === "number" ? (
          <p className="mt-1 text-muted-foreground text-xs">
            {outcome.agentErrors > 0
              ? `${outcome.agentErrors} agent action(s) failed during the run.`
              : "No agent action failed, so the personas were reached and posted nothing."}
          </p>
        ) : null}
        <p className="mt-1 text-muted-foreground text-xs">
          Reported as <code>{outcome.kind}</code> — {failure.record}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={outcome.verdict.usable ? "default" : "secondary"}>
          {outcome.verdict.usable ? "DIVERGED" : "COLLAPSED"}
        </Badge>
        {/*
          A PARTIAL run still gets a badge, because it was genuinely judged —
          but the badge is measured over the survivors, not over the audience
          the founder picked, and that has to be visible next to it.
        */}
        {outcome.verdict.agentErrors ? (
          <Badge variant="outline">
            PARTIAL — {outcome.verdict.agentErrors} agent action(s) failed
          </Badge>
        ) : null}
        <span className="text-sm">{outcome.verdict.reason}</span>
      </div>
      <div className="mt-2">
        <DivergenceBar divergence={outcome.verdict.divergence} />
      </div>
      <ReactionList reactions={outcome.reactions} />
    </div>
  );
}

/**
 * THREE STATES, AND `null` IS CHECKED FIRST.
 *
 * `run.usable` is `true` diverged, `false` collapsed, `null` never assessed.
 * Writing `run.usable ? … : …` folds null in with false and puts the COLLAPSED
 * badge on a run that produced nothing — the exact bug this column was made
 * nullable to end. The null branch comes first, and nothing here may treat
 * `usable` as a boolean.
 */
function HistoryRow({ run }: { run: SimulationRun }) {
  const divergence = run.divergence as DivergenceReport | null;
  const notAssessed = run.usable === null;
  return (
    <li className="rounded-md border p-2">
      <div className="flex flex-wrap items-center gap-2">
        {notAssessed ? (
          <Badge variant="outline">NO RESULT</Badge>
        ) : (
          <Badge variant={run.usable ? "default" : "secondary"}>
            {run.usable ? "DIVERGED" : "COLLAPSED"}
          </Badge>
        )}
        <span className="text-muted-foreground text-xs">
          {new Date(run.createdAt).toLocaleString()}
        </span>
      </div>
      <p className="mt-1 line-clamp-2 text-sm">{run.pitch}</p>
      {notAssessed ? (
        <p className="mt-1 text-muted-foreground text-xs">
          This run produced no usable reactions
          {run.notAssessedKind ? ` (${run.notAssessedKind})` : ""}
          {typeof run.agentErrors === "number" && run.agentErrors > 0
            ? ` — ${run.agentErrors} agent action(s) failed`
            : ""}
          . It was not judged, which is different from the personas agreeing.
        </p>
      ) : null}
      {divergence && !notAssessed ? (
        <div className="mt-1">
          <DivergenceBar divergence={divergence} />
        </div>
      ) : null}
    </li>
  );
}

export function SimulationPanel({
  projectId,
  initialPitch,
  history,
}: {
  projectId: string;
  initialPitch: string;
  history: SimulationRun[];
}) {
  const [pitch, setPitch] = useState(initialPitch);
  const [result, setResult] = useState<RunSimulationResult | null>(null);
  const [isPending, startTransition] = useTransition();

  const run = () => {
    startTransition(async () => {
      setResult(await runProjectSimulation({ projectId, pitch }));
    });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label className="font-medium text-sm" htmlFor="simulation-pitch">
          The pitch the personas react to
        </label>
        <Textarea
          className="min-h-24"
          id="simulation-pitch"
          onChange={(event) => setPitch(event.target.value)}
          placeholder="One or two sentences describing what you are offering, and to whom."
          value={pitch}
        />
        <div className="flex items-center gap-3">
          <Button disabled={isPending || !pitch.trim()} onClick={run} size="sm">
            {isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <FlaskConical className="size-4" />
            )}
            {isPending ? "Running…" : "Run simulation"}
          </Button>
          <p className="text-muted-foreground text-xs">
            Synthetic personas, not customers. Their objections are questions to
            ask real users — never evidence of demand.
          </p>
        </div>
      </div>

      {result ? <OutcomePanel result={result} /> : null}

      <div>
        <h2 className="font-medium text-sm">Past runs</h2>
        {history.length === 0 ? (
          <p className="mt-1 text-muted-foreground text-sm">
            Nothing yet. Runs are kept whether they diverged, collapsed, or
            produced nothing at all.
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {history.map((run_) => (
              <HistoryRow key={run_.id} run={run_} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
