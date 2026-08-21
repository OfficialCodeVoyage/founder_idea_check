"use client";

import { useState, useTransition } from "react";
import { correctFact, deleteFact } from "@/app/actions/correct-fact";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/**
 * One fact, correctable and deletable.
 *
 * THE CONFIDENCE IS READ-ONLY, ON PURPOSE, and the UI says why rather than
 * leaving a founder to wonder where the control is. Confidence is the
 * extractor's certainty at the moment it recorded the fact — the exported
 * FACTS.md states that in as many words — and it is the single dial that would
 * let someone raise their own evidence and pass their own gate on it.
 *
 * A corrected fact is labelled YOURS everywhere afterwards, including in the
 * prompt the judge reads. That is the trade being offered: you can fix what the
 * extractor got wrong, and the fix travels as your assertion rather than as
 * something a customer said.
 */
export function FactRow({
  projectId,
  factKey,
  value,
  confidence,
  phaseKey,
  origin,
}: {
  projectId: string;
  factKey: string;
  value: string;
  confidence: number;
  phaseKey: string;
  origin: "extracted" | "founder";
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [isPending, startTransition] = useTransition();

  const save = () => {
    setError(null);
    startTransition(async () => {
      const result = await correctFact({
        projectId,
        key: factKey,
        value: draft,
      });
      if (result.status === "saved") {
        setEditing(false);
        return;
      }
      setError(
        result.status === "invalid"
          ? result.detail
          : "That could not be saved. Reload and try again."
      );
    });
  };

  const remove = () => {
    setError(null);
    startTransition(async () => {
      const result = await deleteFact({ projectId, key: factKey });
      if (result.status !== "saved") {
        setError("That could not be deleted. Reload and try again.");
      }
    });
  };

  return (
    <li className="rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <code className="font-medium text-sm">{factKey}</code>
        {origin === "founder" ? (
          <Badge variant="outline">YOURS — not extracted</Badge>
        ) : null}
        <span className="text-muted-foreground text-xs">
          confidence {confidence}
        </span>
        <span className="text-muted-foreground text-xs">{phaseKey}</span>
      </div>

      {editing ? (
        <div className="mt-2 space-y-2">
          <Textarea
            className="min-h-20 text-sm"
            onChange={(event) => setDraft(event.target.value)}
            value={draft}
          />
          <p className="text-muted-foreground text-xs">
            Saving marks this as your own assertion, not something read out of
            the transcript. The gate is told the difference. Its confidence
            stays at {confidence} — that number is the extractor's certainty
            when it recorded the fact, and nothing may revise it upwards.
          </p>
          <div className="flex gap-2">
            <Button disabled={isPending} onClick={save} size="sm">
              Save correction
            </Button>
            <Button
              disabled={isPending}
              onClick={() => {
                setDraft(value);
                setEditing(false);
                setError(null);
              }}
              size="sm"
              variant="ghost"
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <p className="mt-1 text-sm">{value}</p>
      )}

      {error ? <p className="mt-2 text-destructive text-xs">{error}</p> : null}

      {editing ? null : (
        <div className="mt-2 flex gap-3 text-xs">
          <button
            className="underline underline-offset-2 opacity-70 hover:opacity-100"
            onClick={() => setEditing(true)}
            type="button"
          >
            Correct
          </button>
          {confirmingDelete ? (
            <>
              {/*
                The warning is not decoration. Facts are what the gate counts:
                deleting enough of them can drop a phase below its minimum and
                turn a PASS into a BLOCK. Better to say so before the click than
                to let a refusal arrive unexplained a turn later.
              */}
              <span className="text-muted-foreground">
                Delete this? It also stops grounding your persona, simulation
                and export — and can drop this phase below the fact count its
                gate requires.
              </span>
              <button
                className="text-destructive underline underline-offset-2"
                disabled={isPending}
                onClick={remove}
                type="button"
              >
                Yes, delete
              </button>
              <button
                className="underline underline-offset-2 opacity-70"
                onClick={() => setConfirmingDelete(false)}
                type="button"
              >
                Keep it
              </button>
            </>
          ) : (
            <button
              className="underline underline-offset-2 opacity-70 hover:opacity-100"
              onClick={() => setConfirmingDelete(true)}
              type="button"
            >
              Delete
            </button>
          )}
        </div>
      )}
    </li>
  );
}
