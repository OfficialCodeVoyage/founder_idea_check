"use client";

import { useQuery } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type AttemptLedgerStep,
  advanceRailWait,
  type ChecklistCriterion,
  RAIL_POLL_CEILING_MS,
  RAIL_POLL_INTERVAL_MS,
  type RailWait,
} from "@/lib/phases/rail";
import type { CriterionStatus, GateObstacle } from "@/lib/phases/types";
import { useTRPC } from "@/trpc/react";

/**
 * ONE POLL, ONE WAIT, TWO RENDERERS.
 *
 * The rail and the verdict card describe the same gate decision. This owns the
 * `phase.getState` query and the wait state machine so they cannot disagree
 * about whether a verdict has landed — react-query would dedupe the fetch on
 * its own, but two components running `advanceRailWait` independently would
 * keep two ceilings and two baselines, and could show "checking…" in one place
 * and a stale verdict as current in the other.
 *
 * The timing this exists to handle: `runPostTurnPhasePass` runs inside
 * `after()` in app/(chat)/api/chat/route.ts, i.e. AFTER the response has
 * flushed, 15-30s after the stream ends. There is no push channel for it. So
 * the wait is edge-triggered on the stream ENDING and cleared by
 * `assessmentCount` actually CHANGING, rather than by guessing a delay.
 *
 * Lifted verbatim out of components/phase-rail.tsx, where it lived alone.
 */

/** Slow recovery poll once the wait has already timed out. */
const SLOW_POLL_MS = 15_000;

function pollInterval(kind: RailWait["kind"]): number | false {
  if (kind === "waiting") {
    return RAIL_POLL_INTERVAL_MS;
  }
  if (kind === "unreported") {
    return SLOW_POLL_MS;
  }
  return false;
}

type PhaseGateState = {
  /** Null until the first read lands. Consumers render nothing until then. */
  data: PhaseGateData | null;
  wait: RailWait;
};

export type PhaseGateData = {
  phaseKey: string;
  title: string;
  order: number;
  total: number;
  status: string;
  workflowComplete: boolean;
  decision: "PASS" | "WARN" | "BLOCK" | null;
  reason: string | null;
  nextQuestion: string | null;
  missing: string[];
  assessmentCount: number;
  /**
   * Criteria the judge actually scored, and whether the stored verdict parsed.
   * The rail ignores both; the verdict card needs them to tell a real refusal
   * apart from a gate that failed closed. See PhaseGateState in
   * lib/phases/directive.ts.
   */
  criteriaAssessed: number;
  verdictReadable: boolean;
  /**
   * Which rule the gate broke on, so the card can head its list with the right
   * words. NULL for any verdict stored before the arm existed.
   */
  obstacle: GateObstacle | null;
  /**
   * Gate runs on THIS phase — the card's "Attempt 7". Distinct from
   * `assessmentCount` above, which sums every phase and exists only so the
   * wait can detect a verdict landing.
   */
  attemptCount: number;
  /** What this phase is judged against, from the same resolved phase. */
  criteria: ChecklistCriterion[];
  /**
   * The judge's result per criterion. EMPTY is not "all eight untouched" — read
   * it with `criteriaAssessed` and `verdictReadable`, which say which of the
   * two absences it is.
   */
  perCriterion: { criterionId: string; status: CriterionStatus }[];
  /** Every recorded attempt on this phase, with its diff. Oldest first. */
  ledger: AttemptLedgerStep[];
};

const PhaseGateContext = createContext<PhaseGateState | null>(null);

export function PhaseGateProvider({
  projectId,
  isStreaming,
  children,
}: {
  projectId: string;
  /** True while the assistant is answering. The gate runs AFTER that. */
  isStreaming: boolean;
  children: ReactNode;
}) {
  const trpc = useTRPC();
  const [wait, setWait] = useState<RailWait>({ kind: "idle" });
  const { data } = useQuery({
    ...trpc.phase.getState.queryOptions({ projectId }),
    refetchInterval: pollInterval(wait.kind),
    refetchIntervalInBackground: true,
  });

  // Held in a ref so the turn-ended effect can seed its baseline without taking
  // `data` as a dependency — re-running it on every poll would restart the
  // ceiling timer each tick and the wait would never expire.
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

  return (
    <PhaseGateContext.Provider
      value={{ data: (data as PhaseGateData | undefined) ?? null, wait }}
    >
      {children}
    </PhaseGateContext.Provider>
  );
}

/**
 * Null outside a project. Both consumers are mounted only when `projectId` is
 * set, but returning null rather than throwing keeps a non-project chat from
 * crashing if one is ever rendered unguarded.
 */
export function usePhaseGate(): PhaseGateState | null {
  return useContext(PhaseGateContext);
}
