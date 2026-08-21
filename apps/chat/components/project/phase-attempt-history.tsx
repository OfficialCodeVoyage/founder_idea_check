"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { useTRPC } from "@/trpc/react";

/**
 * EVERY VERDICT THIS PHASE HAS EVER RECEIVED.
 *
 * `ProjectPhaseAttempt` has been appended to on every gate run since it was
 * built, and read by nothing — `getProjectPhaseAttempts` had no caller at all.
 * In the dev database that is 11 recorded attempts, including one phase that
 * took four, none of which a founder could see.
 *
 * FETCHED ON OPEN, not with the roster. Loading all eight phases' ledgers on
 * first paint costs eight queries for history most founders will not read.
 */
const DECISION_BADGE = {
  BLOCK: { label: "BLOCKED", variant: "destructive" },
  WARN: { label: "THIN", variant: "secondary" },
  PASS: { label: "PASSED", variant: "default" },
} as const;

function CriterionList({
  ids,
  label,
  tone,
}: {
  ids: readonly string[];
  label: string;
  tone: string;
}) {
  if (ids.length === 0) {
    return null;
  }
  return (
    <p className={`text-xs ${tone}`}>
      <span className="font-medium">{label}:</span> {ids.join(", ")}
    </p>
  );
}

export function PhaseAttemptHistory({
  projectId,
  phaseKey,
  phaseTitle,
  attemptCount,
}: {
  projectId: string;
  phaseKey: string;
  phaseTitle: string;
  attemptCount: number;
}) {
  const trpc = useTRPC();
  const [open, setOpen] = useState(false);
  const { data, isPending } = useQuery({
    ...trpc.phase.attempts.queryOptions({ phaseKey, projectId }),
    enabled: open,
  });

  if (!open) {
    return (
      <button
        className="mt-2 text-xs underline underline-offset-2 opacity-70 hover:opacity-100"
        onClick={() => setOpen(true)}
        type="button"
      >
        {attemptCount === 1
          ? "Read the verdict"
          : `Read all ${attemptCount} verdicts`}
      </button>
    );
  }

  return (
    <div className="mt-3 border-t pt-2">
      <div className="flex items-center justify-between">
        <p className="font-medium text-xs uppercase tracking-wide opacity-70">
          {phaseTitle} — every verdict
        </p>
        <button
          className="text-xs underline underline-offset-2 opacity-70 hover:opacity-100"
          onClick={() => setOpen(false)}
          type="button"
        >
          Hide
        </button>
      </div>

      {isPending ? (
        <p className="mt-2 text-muted-foreground text-xs">Loading…</p>
      ) : null}

      {/*
        FEWER STORED VERDICTS THAN ATTEMPTS IS EXPECTED, AND IT MUST SAY SO.
        `ProjectPhase.attemptCount` has been incremented since the beginning;
        the ledger was added later, and the old `onConflictDoUpdate` kept only
        the newest verdict per phase — so every refusal before that change is
        gone and unrecoverable (DATA-LAYER.md says so outright). Verified in the
        dev data: go-to-market counts 4 attempts and stores 3 verdicts, the
        first of them numbered #2.

        Rendering the shorter list without this note would quietly imply the
        founder is seeing everything the gate ever said about this phase. They
        are not, and a missing refusal is exactly the thing this screen exists
        to stop hiding.
      */}
      {data && data.length < attemptCount ? (
        <p className="mt-2 text-muted-foreground text-xs">
          {data.length === 0
            ? `This phase records ${attemptCount} attempt(s) and no stored verdicts at all.`
            : `Showing ${data.length} of ${attemptCount} attempts.`}{" "}
          The earlier verdicts were overwritten before this app kept a history,
          and cannot be recovered. Everything from here on is kept.
        </p>
      ) : null}

      <ol className="mt-2 space-y-3">
        {data?.map((step) => {
          const badge = DECISION_BADGE[step.decision];
          return (
            <li
              className="space-y-1"
              key={`${step.attemptNo}-${step.evaluatedAt}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground text-xs tabular-nums">
                  #{step.attemptNo}
                </span>
                <Badge variant={badge.variant}>{badge.label}</Badge>
                <span className="text-muted-foreground text-xs">
                  {new Date(step.evaluatedAt).toLocaleString()}
                </span>
              </div>

              <p className="text-sm">{step.reason}</p>

              {step.detail.readable ? null : (
                <p className="text-muted-foreground text-xs">
                  {step.detail.why}
                </p>
              )}

              {/*
                A gate that failed closed reached a decision and scored nothing.
                Without saying so, its entry looks like an ordinary refusal and
                the founder reads a plumbing failure as a judgement of their
                work — and the diff around it is deliberately blank, which needs
                explaining too.
              */}
              {step.detail.readable && step.detail.failedClosed ? (
                <p className="text-muted-foreground text-xs">
                  The gate did not run on this attempt — no criterion was
                  scored, so nothing here says anything about your work, and it
                  is not compared with the attempts either side.
                </p>
              ) : null}

              {/*
                THE DIFF IS THE POINT. "You closed evidence-of-pain on attempt 3
                and willingness-to-pay is still open" is what turns a list of
                refusals into a record of learning. Empty on the first attempt,
                deliberately — nobody broke eight things on their first turn.
              */}
              <CriterionList
                ids={step.closed}
                label="Closed since the last attempt"
                tone="text-emerald-600 dark:text-emerald-400"
              />
              <CriterionList
                ids={step.stillOpen}
                label="Still open"
                tone="text-muted-foreground"
              />
              <CriterionList
                ids={step.opened}
                label="Newly unmet"
                tone="text-destructive"
              />
            </li>
          );
        })}
      </ol>
    </div>
  );
}
