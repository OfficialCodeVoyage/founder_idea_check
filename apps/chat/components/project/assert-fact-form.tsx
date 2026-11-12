"use client";

import { useState, useTransition } from "react";
import { assertFact } from "@/app/actions/correct-fact";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

/**
 * WHERE THE FIELDWORK COMES BACK.
 *
 * The gate classifies a criterion it cannot close in conversation as
 * `offline-only` and then asks for the INSTRUMENT — who you will talk to, how
 * many, what you will ask, and the pass/fail threshold fixed before any data
 * arrives (`instrumentQuestion`, lib/phases/gate.ts). A founder who went and
 * ran it had nowhere to put the answer: facts were only ever model-extracted
 * from the transcript, so the only route back in was pasting five field logs
 * into chat and hoping the extractor picked them up.
 *
 * STRUCTURED, NOT A FREE-TEXT BLOB, and that is the whole point — the founder
 * names the fact key and the value directly, which is what bypasses the
 * extractor's guesswork. The keys offered are the current phase's `factKeys`,
 * the same vocabulary `sanitizeFacts` restricts the extractor to, minus the
 * ones already holding a fact.
 *
 * WHAT THE FORM DOES NOT HAVE IS A CONFIDENCE FIELD, and the copy says so
 * rather than leaving a founder to wonder where it went. A founder who could
 * type both the evidence and its confidence could walk themselves through their
 * own gate, which inverts the entire product. `FactRow` makes the same argument
 * about the correction path; this is the same rule at the other door.
 */

/**
 * WHICH KEY IS SELECTED — and "none yet" is its own arm carrying no key.
 *
 * The obvious shape here is `useState("")`, and an empty string standing in for
 * "the founder has not chosen" is the same bug this codebase has now fixed six
 * times in other clothes: a submit handler reads `key` and posts a blank one, a
 * render reads it and shows an unnamed fact. There is nothing to misread off
 * `none-chosen`.
 */
type KeyChoice = { kind: "none-chosen" } | { kind: "chosen"; key: string };

/**
 * THE RESULT OF THE LAST ATTEMPT. `idle` carries no message, because a form
 * that has not been submitted has not said anything — an empty error string
 * would render as a cleared error, which is a claim.
 */
type SubmitState =
  | { kind: "idle" }
  | { kind: "recorded"; key: string; confidence: number }
  | { kind: "refused"; detail: string };

export function AssertFactForm({
  projectId,
  phaseTitle,
  availableKeys,
  heldKeyCount,
}: {
  projectId: string;
  /** The phase whose vocabulary these keys come from, in the founder's words. */
  phaseTitle: string;
  /** Keys this phase records that do not already hold a fact. */
  availableKeys: readonly string[];
  /** How many of this phase's keys are already taken — see the note below. */
  heldKeyCount: number;
}) {
  const [choice, setChoice] = useState<KeyChoice>({ kind: "none-chosen" });
  const [draft, setDraft] = useState("");
  const [state, setState] = useState<SubmitState>({ kind: "idle" });
  const [isPending, startTransition] = useTransition();

  const submit = () => {
    if (choice.kind === "none-chosen") {
      setState({
        kind: "refused",
        detail: "Pick which fact this is before writing it down.",
      });
      return;
    }
    const key = choice.key;
    startTransition(async () => {
      const result = await assertFact({ projectId, key, value: draft });
      if (result.status === "recorded") {
        setChoice({ kind: "none-chosen" });
        setDraft("");
        setState({
          kind: "recorded",
          key: result.key,
          confidence: result.confidence,
        });
        return;
      }
      setState({
        kind: "refused",
        detail:
          result.status === "invalid" || result.status === "key-already-held"
            ? result.detail
            : "That could not be saved. Reload and try again.",
      });
    });
  };

  if (availableKeys.length === 0) {
    return (
      <div className="mb-6 rounded-md border border-dashed p-3">
        <p className="text-muted-foreground text-sm">
          {/*
            "Nothing to add" and "this phase records nothing" are different
            states and get different sentences. Rendering an empty dropdown for
            either would say neither.
          */}
          {heldKeyCount > 0
            ? `Every fact ${phaseTitle} records already holds a value. If one of them is wrong, correct it below — a correction keeps the score the fact already has rather than replacing it with yours, and marks the fact as yours.`
            : `${phaseTitle} records no facts you can enter by hand.`}
        </p>
      </div>
    );
  }

  return (
    <div className="mb-6 rounded-md border p-3">
      <h2 className="font-medium text-sm">Enter evidence you gathered</h2>
      <p className="mt-1 max-w-2xl text-muted-foreground text-xs">
        If you have run the interviews, the survey or the test the gate asked
        for, write the result here rather than hoping it gets picked up out of
        the chat. It is recorded as <strong>your assertion</strong>, not as
        something a customer said, and the gate is told the difference — an
        assertion is weaker evidence than an observed quote and is weighed as
        such. These are the facts {phaseTitle} records.
      </p>

      <div className="mt-3 space-y-2">
        <Select
          onValueChange={(key) => {
            setChoice({ kind: "chosen", key });
            setState({ kind: "idle" });
          }}
          value={choice.kind === "chosen" ? choice.key : undefined}
        >
          <SelectTrigger className="w-full sm:w-80">
            {/*
              No value prop when nothing is chosen — `undefined`, never "".
              Radix renders the placeholder for an unset value, so the
              not-yet-chosen state has no key to read anywhere, including here.
            */}
            <SelectValue placeholder="Which fact is this?" />
          </SelectTrigger>
          <SelectContent>
            {availableKeys.map((key) => (
              <SelectItem key={key} value={key}>
                {key}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Textarea
          className="min-h-20 text-sm"
          onChange={(event) => {
            setDraft(event.target.value);
            setState({ kind: "idle" });
          }}
          placeholder="One sentence you would defend, not the field notes behind it. What did you actually find?"
          value={draft}
        />

        <p className="text-muted-foreground text-xs">
          There is no confidence box, on purpose. Confidence is not a quality
          score you set. For a fact read out of your chat it is how sure the
          extractor was. A fact you enter by hand gets a fixed floor score, the
          lowest any fact in this ledger can hold, and is marked as yours;
          typing a more emphatic sentence will not move it. If you later correct
          a fact, it keeps the score it already had, which was about the earlier
          wording, not yours. Nothing may raise a score. That is what stops
          anyone passing their own gate on their own assumption.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={isPending} onClick={submit} size="sm">
            Record this fact
          </Button>
          {state.kind === "recorded" ? (
            <span className="text-muted-foreground text-xs">
              Recorded {state.key} as yours, at confidence {state.confidence}.
              The gate re-checks on your next turn.
            </span>
          ) : null}
          {state.kind === "refused" ? (
            <span className="text-destructive text-xs">{state.detail}</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
