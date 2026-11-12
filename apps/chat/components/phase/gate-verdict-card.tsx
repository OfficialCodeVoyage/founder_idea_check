"use client";

import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  type AttemptProgress,
  type ChecklistState,
  type CriterionChecklist,
  describeAttemptStanding,
  describeCriterionChecklist,
  describeGateVerdict,
  type GateVerdictView,
} from "@/lib/phases/rail";
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
 *
 * WHAT SEVEN IDENTICAL REFUSALS TAUGHT THIS CARD. The live problem-validation
 * deadlock produced seven of these, each rendering exactly like the last. The
 * founder called it "a lot of pushbacks", and they were right, because a card
 * that cannot say WHERE YOU ARE has nothing to offer but the refusal itself.
 * Four things were added for that, and each one is a fact the app already had:
 *
 *   the attempt number      "Attempt 7" — the ledger has always known
 *   the repeat count        this criterion has blocked four of them
 *   the diff, regressions   four criteria closed and re-opened, twice, unsaid
 *   the full checklist      what the other seven criteria are, and their state
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

type AssessedView = Extract<GateVerdictView, { assessed: true }>;

/**
 * THE NAMED GAPS — printed once.
 *
 * `decideGate` writes its reason as "<summary>: <every gap joined by '; '>",
 * and the card printed that sentence AND the same gaps as a list. On attempt 7
 * of the live deadlock the reason and `missing[0]` were the same clause, so
 * half of a small card was one sentence twice; on attempt 1 the reason was five
 * joined gaps, truncated mid-sentence by a 300-character cap that has since
 * moved to the prompt alone, sitting above the same five rendered properly.
 *
 * `view.headline` is the split, decided on the TEXT in rail.ts and never on the
 * list's length — suppressing every one-item list would delete the ordinary
 * shape of a refusal, which is the one thing this card exists to show.
 */
function GapList({ view }: { view: AssessedView }) {
  if (view.coverage.kind !== "scored" || view.gaps.length === 0) {
    return null;
  }
  if (view.headline.kind === "instead-of-list") {
    return null;
  }
  return (
    <div className="mt-3">
      {/*
        THE HEADING IS PER-ARM. It used to be the literal string "What is
        missing" over whatever `missing` held — so on four of the seven live
        attempts it read "WHAT IS MISSING" above text that said "could not be
        assessed". Those are opposite situations with opposite remedies, and the
        founder could not tell which one they were in.
      */}
      <p className="font-medium text-foreground/75 text-xs uppercase tracking-wide">
        {`${view.obstacle?.heading ?? "What is missing"} — ${view.gaps.length} of ${view.coverage.criteria} criteria`}
      </p>
      <ul className="mt-1 space-y-1">
        {/*
          EVERY gap, not `missing.at(0)`. The rail shows one because it has one
          line; this is the surface that exists so the rest are not invisible.

          Keyed by criterion id, not by gap text: every criterion the judge
          left without a gap shares one fallback sentence, so text keys
          collided. See `gapKeys`.
        */}
        {view.gaps.map((gap, index) => (
          <li className="flex gap-2 text-sm" key={view.gapKeys[index]}>
            <span aria-hidden="true" className="text-foreground/75">
              —
            </span>
            <span>{gap}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * WHAT MOVED SINCE THE LAST ATTEMPT, AND WHAT MOVED BACKWARDS.
 *
 * The live verdicts went 5 → 1 → 1 → 1 → 5 → 5 → 1 unmet. The founder closed
 * four criteria, watched them re-open twice, and was told none of it — the diff
 * was computed on every run and rendered only inside a panel behind a link.
 *
 * REGRESSIONS COME FIRST AND IN THEIR OWN BOX. Under a list of things that went
 * well, "newly unmet" reads as a footnote to progress; it is the opposite of
 * progress, and it is the single fact a founder cannot reconstruct from the
 * conversation, because nothing they said caused it.
 */
function AttemptDiff({ progress }: { progress: AttemptProgress | null }) {
  if (!progress) {
    return null;
  }
  return (
    <div className="mt-3 space-y-2">
      {progress.opened.length > 0 ? (
        <div className="rounded border border-destructive-edge bg-destructive-surface p-2">
          <p className="font-medium text-destructive-on-surface text-xs uppercase tracking-wide">
            Newly unmet — this went backwards
          </p>
          <p className="mt-1 text-sm">{progress.opened.join(", ")}</p>
          <p className="mt-1 text-foreground/75 text-xs">
            These were met on the previous attempt and are not met now. Nothing
            you said necessarily caused it — the gate re-reads the whole
            transcript every time — but you would have no way of knowing it had
            happened, so it is said here first.
          </p>
        </div>
      ) : null}
      {progress.closed.length > 0 ? (
        <p className="text-state-met text-xs">
          <span className="font-medium">Closed since the last attempt:</span>{" "}
          {progress.closed.join(", ")}
        </p>
      ) : null}
      {progress.stillOpen.length > 0 ? (
        <p className="text-foreground/75 text-xs">
          <span className="font-medium">Still open:</span>{" "}
          {progress.stillOpen.join(", ")}
        </p>
      ) : null}
    </div>
  );
}

/**
 * "THIS CRITERION HAS BLOCKED FOUR OF YOUR SEVEN ATTEMPTS."
 *
 * The single most useful fact on screen during the deadlock, and the one the
 * card never said. Seven refusals that each looked like the first is how
 * "annoying" happens; a refusal that knows it is the fourth of its kind is an
 * argument for changing approach rather than answering again.
 *
 * ONE SENTENCE, NOT ONE LINE PER CRITERION. Replayed against the real seven
 * attempts, six criteria had blocked all seven of them — as six lines that is a
 * wall of identical text sitting on top of the regression above it. Every
 * repeat is still shown, annotated on its own row in the checklist below.
 */
function RepeatNote({ note }: { note: string | null }) {
  if (!note) {
    return null;
  }
  return <p className="mt-2 text-foreground/75 text-xs">{note}</p>;
}

/**
 * One tone per state. `unscored` shares muted with not-evaluable — the LABEL
 * is what separates them, and the two are neighbouring shades of "unknown"
 * rather than opposite findings.
 *
 * EVERY TEXT TONE IN THIS FILE IS MEASURED, not eyeballed. The three state
 * tones are `--state-met|partial|unmet` (app/globals.css), each checked at
 * 4.5:1 or better against all three card tints and the bare page in both
 * themes. "Muted" text is `text-foreground/75` rather than
 * `text-muted-foreground`, and never `opacity-*`: `--muted-foreground` sits
 * 0.01 above the floor on the BLOCKED tint and below it on the tinted
 * regression box, and an `opacity-*` on text is a contrast loss that depends
 * on whatever happens to be behind it. `foreground/75` is 5.5:1 or better on
 * every surface here, light and dark.
 */
const STATE_TONE: Record<ChecklistState, string> = {
  met: "text-state-met",
  partial: "text-state-partial",
  unmet: "text-state-unmet",
  "not-evaluable": "text-foreground/75",
  unscored: "text-foreground/75",
};

const STATE_MARK: Record<ChecklistState, string> = {
  met: "✓",
  partial: "~",
  unmet: "✗",
  "not-evaluable": "?",
  unscored: "·",
};

/**
 * ALL EIGHT CRITERIA, COLLAPSED.
 *
 * Through seven refusals the founder never saw what they were being judged
 * against — the list lives on the Phases screen, one navigation away from where
 * the work happens. Collapsed by default because the blocking gap above is
 * still the headline; expandable because "4 closed, this one needs fieldwork,
 * three untouched" is what turns a refusal into a position.
 *
 * IT DRAWS NO ROWS FOR A VERDICT THAT NEVER RAN. `describeCriterionChecklist`
 * returns an arm with no `rows` at all when nothing was scored, so eight grey
 * "untouched" rows cannot be rendered over a gate that failed closed.
 * `explainAbsence` is false when the card is ALREADY saying so a few lines up —
 * the fail-closed and unreadable notices — so the same fact is not stated twice.
 */
function CriteriaChecklist({
  checklist,
  explainAbsence,
}: {
  checklist: CriterionChecklist;
  explainAbsence: boolean;
}) {
  if (!checklist.available) {
    return explainAbsence ? (
      <p className="mt-2 text-foreground/75 text-sm">{checklist.note}</p>
    ) : null;
  }
  return (
    <details className="mt-3 border-t pt-2">
      <summary className="cursor-pointer text-foreground/75 text-xs hover:text-foreground">
        All {checklist.rows.length} exit criteria — {checklist.summary}
      </summary>
      <ul className="mt-2 space-y-2">
        {checklist.rows.map((row) => (
          <li className="flex gap-2 text-xs" key={row.id}>
            <span
              aria-hidden="true"
              className={cn("w-3 shrink-0", STATE_TONE[row.state])}
            >
              {STATE_MARK[row.state]}
            </span>
            <span className="min-w-0">
              <span className="font-medium">{row.id}</span>
              <span className={cn("ml-2", STATE_TONE[row.state])}>
                {row.label}
              </span>
              {/*
                WHY IT IS OPEN MATTERS MORE THAN THAT IT IS OPEN. "you have not
                said this" and "nobody could say this yet" have opposite
                remedies, and asking for the second is what produced a gate
                demanding four rubric scores from a founder with no interviews.
              */}
              {row.state !== "met" && row.closure === "offline-only" ? (
                <span className="ml-2 text-foreground/75">
                  needs field data
                </span>
              ) : null}
              {row.severity === "advisory" ? (
                <span className="ml-2 text-foreground/75">advisory only</span>
              ) : null}
              {row.repeat ? (
                <span className="ml-2 text-foreground/75">
                  blocked {row.repeat.blocked} of {row.repeat.of} attempts
                </span>
              ) : null}
              <span className="mt-0.5 block text-foreground/75">
                {row.description}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * THE ONE LINE THE CLOSED CARD SHOWS.
 *
 * It has to survive on its own, so the two arms that carry no list say what
 * they are rather than quoting `reason` (which on `none-scored` is a plumbing
 * message, not a finding about the work). Everywhere else it is the same text
 * the open card prints first: the headline, else the first named gap, else the
 * gate's "named nothing" note. The open card still prints all of it, whole.
 */
function summaryLine(view: AssessedView): string | null {
  if (view.coverage.kind === "none-scored") {
    return "The gate could not assess this phase.";
  }
  if (view.coverage.kind === "unreadable") {
    return "This verdict can no longer be read.";
  }
  if (view.headline.kind !== "none") {
    return view.headline.text;
  }
  return view.gaps.at(0) ?? view.noGapNote;
}

/**
 * COMPACT BY DEFAULT, A SCROLLING REGION WHEN OPEN.
 *
 * The card sits above the composer, inside a pane whose height is fixed to the
 * viewport (`MainChatPanel`, `h-[calc(100dvh_-_…)]`, in an `overflow: hidden`
 * ancestor). Nothing above it scrolls, so a card taller than the room it is
 * given does not push the page — it CUTS OFF whatever does not fit, and what did
 * not fit was the composer. Measured in a browser on the live attempt-7 verdict
 * when it was one tall block in a `shrink-0` slot: closed, 656px in a 579px pane
 * at 375×667 (founder cannot type); open, 876 to 1392px at every size, with the
 * checklist rows, "Next", both links and the composer unreachable; and even at
 * 1280×800 closed it left the transcript 105px, so the assistant's last
 * sentence ended under the card's border.
 *
 * So the card is ONE ROW until asked: badge, phase, attempt, the headline on a
 * single line, and a chevron. Everything the card ever said is still there, in
 * a region under the row, capped at `min(30dvh, 20rem)` with its own scrollbar
 * — the cap is relative to the viewport, so the transcript keeps most of a
 * phone's pane and the composer is never pushed out. The cap is the ceiling,
 * not the floor: the card and its region are flex items that may shrink
 * (`min-h-0`), so on a landscape phone the region gives way before the
 * composer does.
 *
 * A REGRESSION CANNOT HIDE IN THE COLLAPSED STATE. "Newly unmet — this went
 * backwards" is the one fact a founder cannot reconstruct from the
 * conversation, and the reason the diff has its own box when open. Closed, it
 * is a chip in the summary row, in the same destructive pair as that box.
 *
 * THE REGION IS `aria-live="off"` ON PURPOSE. The `<output>` around the card is
 * a live region so a new verdict is announced; without this, expanding the
 * details would make a screen reader read the whole body aloud as if it were a
 * new verdict.
 */
export function GateVerdictCard({
  projectId,
  className,
}: {
  projectId: string;
  className?: string;
}) {
  const gate = usePhaseGate();
  const [expanded, setExpanded] = useState(false);
  const regionId = useId();
  if (!gate?.data) {
    return null;
  }

  const view = describeGateVerdict({
    assessment: gate.wait.kind,
    criteriaAssessed: gate.data.criteriaAssessed,
    decision: gate.data.decision,
    missing: gate.data.missing,
    nextQuestion: gate.data.nextQuestion,
    obstacle: gate.data.obstacle,
    reason: gate.data.reason,
    total: gate.data.total,
    perCriterion: gate.data.perCriterion,
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

  // Both read the SAME payload as the verdict above, in the same render, so the
  // attempt number, the diff and the checklist cannot describe a different
  // verdict from the one badged at the top.
  const standing = describeAttemptStanding({
    attemptCount: gate.data.attemptCount,
    ledger: gate.data.ledger,
    criteria: gate.data.criteria,
  });
  const checklist = describeCriterionChecklist({
    criteria: gate.data.criteria,
    perCriterion: gate.data.perCriterion,
    repeats: standing.repeats,
    verdictReadable: gate.data.verdictReadable,
  });
  const line = summaryLine(view);
  const wentBackwards = standing.progress?.opened.length ?? 0;

  return (
    <output
      className={cn(
        // The composer is pulled up 16px from 500px wide (`MessagesPane`,
        // `@[500px]:bottom-4`) and has 8px of its own top padding, so the
        // visible gap between this card and the composer's box is this
        // padding minus 8px: `pb-2` left them touching (0px at 768 and 1280).
        // `pb-5` makes it 12px there; below 500px the composer is not pulled
        // up and `pb-2` already leaves 16px.
        "mx-auto flex min-h-0 w-full flex-col px-2 @[500px]:pb-5 pb-2 md:max-w-3xl",
        className
      )}
    >
      <div
        className={cn(
          "flex min-h-0 flex-col rounded-lg border",
          STATUS_STYLE[view.status]
        )}
      >
        {/*
          THE WHOLE ROW IS THE CONTROL: a phone thumb should not have to find a
          12px chevron. The name a screen reader hears is the row's text, so the
          sr-only lead says what the row is.
        */}
        <button
          aria-controls={regionId}
          aria-expanded={expanded}
          className="flex w-full shrink-0 cursor-pointer items-start gap-2 rounded-lg p-3 text-left hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setExpanded((open) => !open)}
          type="button"
        >
          <span className="grid min-w-0 flex-1 grid-cols-1 gap-1">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="sr-only">Gate verdict: </span>
              <Badge variant={STATUS_VARIANT[view.status]}>{view.label}</Badge>
              <span className="font-medium text-sm">{gate.data.title}</span>
              {/*
                WHICH REFUSAL THIS IS. Seven of them arrived looking identical
                and standalone, and that identity is why the seventh read as
                pushback rather than as position in a sequence. Null, never
                "Attempt 0", before the gate has run.
              */}
              {standing.attemptLabel ? (
                <span className="text-foreground/75 text-xs tabular-nums">
                  {standing.attemptLabel}
                </span>
              ) : null}
              {wentBackwards > 0 ? (
                <span className="rounded-full border border-destructive-edge bg-destructive-surface px-2 py-0.5 font-medium text-destructive-on-surface text-xs">
                  {wentBackwards} went backwards
                </span>
              ) : null}
              {/*
                Shown at every breakpoint. It is the only signal that this card
                may be describing an EARLIER turn, and a founder reading a
                refusal needs to know whether it judged what they just said.
              */}
              {view.pending ? (
                <span className="text-foreground/75 text-xs italic">
                  {view.pending.marker}
                </span>
              ) : null}
            </span>
            {line ? (
              <span className="block truncate text-sm">{line}</span>
            ) : null}
          </span>
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "mt-0.5 size-4 shrink-0 text-foreground/75 transition-transform motion-reduce:transition-none",
              expanded && "rotate-180"
            )}
          />
        </button>

        <section
          aria-label="Verdict details"
          aria-live="off"
          className="max-h-[min(30dvh,20rem)] min-h-0 overflow-y-auto overscroll-contain border-t px-3 pt-2 pb-3"
          hidden={!expanded}
          id={regionId}
        >
          <p className="text-foreground/75 text-xs">
            Phase {gate.data.order} of {gate.data.total}
          </p>

          {/*
            THE SUMMARY HALF ONLY. `view.headline` is `view.reason` with its
            trailing restatement of the gap list cut off, so the gaps below are
            not the same sentences a second time — and on the `instead-of-list`
            arm this IS the whole reason and GapList renders nothing.
          */}
          {view.headline.kind === "none" ? null : (
            <p className="mt-2 text-sm">{view.headline.text}</p>
          )}

          {/*
            THE GATE NEVER RAN. `failClosedVerdict` returns `perCriterion: []`
            and `missing: [reason]`, so listing `missing` here would tell a
            founder that one specific thing is missing when in truth nothing was
            judged and every criterion is still pending. It is a plumbing
            failure wearing a refusal's clothes, and it gets its own sentence
            instead.
          */}
          {view.coverage.kind === "none-scored" ? (
            <p className="mt-3 rounded border border-dashed p-2 text-sm">
              <span className="font-medium">
                The gate could not assess this phase.
              </span>{" "}
              No criterion was scored, so this is not a judgement of your work —
              nothing above tells you what to change. Send another message and
              it will try again.
            </p>
          ) : null}

          {view.coverage.kind === "unreadable" ? (
            <p className="mt-3 rounded border border-dashed p-2 text-sm">
              <span className="font-medium">
                This verdict can no longer be read.
              </span>{" "}
              The decision above was stored, but its detail no longer matches
              the shape this app expects — so the absence of a list below is a
              reading failure, not a clean bill of health.
            </p>
          ) : null}

          <GapList view={view} />

          {/*
            WHAT THIS STATE IS, AND WHAT CLOSES IT. Without this the list above
            is a set of sentences with no instruction attached — and for
            `fieldwork-required` the correct instruction is the opposite of the
            obvious one: do NOT try to answer these, build the instrument.
          */}
          {view.coverage.kind === "scored" && view.obstacle ? (
            <p className="mt-2 text-foreground/75 text-sm">
              {view.obstacle.note}
            </p>
          ) : null}

          {view.coverage.kind === "scored" && view.noGapNote ? (
            <p className="mt-2 text-foreground/75 text-sm">{view.noGapNote}</p>
          ) : null}

          <AttemptDiff progress={standing.progress} />
          <RepeatNote note={standing.repeatNote} />
          <CriteriaChecklist
            checklist={checklist}
            explainAbsence={view.coverage.kind === "scored"}
          />

          {view.nextQuestion ? (
            <p className="mt-3 border-t pt-2 text-sm">
              <span className="font-medium">Next: </span>
              {view.nextQuestion}
            </p>
          ) : null}

          <div className="mt-2 flex gap-3 text-xs">
            <Link
              className="text-foreground/75 underline underline-offset-2 hover:text-foreground"
              href={`/project/${projectId}/phases`}
            >
              All phases and past verdicts
            </Link>
            <Link
              className="text-foreground/75 underline underline-offset-2 hover:text-foreground"
              href={`/project/${projectId}/canvas`}
            >
              Canvas
            </Link>
          </div>
        </section>
      </div>
    </output>
  );
}
