"use client";

import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { useId, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-mobile";
import { config } from "@/lib/config";
import {
  buildDraftChatSubmission,
  normalizeSelectedModel,
} from "@/lib/draft-chat-submission";
import {
  type AttemptProgress,
  type AttemptStandingView,
  type ChecklistGroups,
  type ChecklistState,
  type CriterionChecklist,
  describeAttemptStanding,
  describeCriterionChecklist,
  describeGateVerdict,
  describeStatusStrip,
  type GateVerdictView,
  type GroupedChecklistRow,
  gapsByCriterion,
  groupChecklistRows,
  humanizeCriterionId,
  type RailAssessment,
  type StatusStrip,
} from "@/lib/phases/rail";
import type { GateObstacle } from "@/lib/phases/types";
import {
  useSendDraftChatSubmission,
  useSendFlight,
} from "@/lib/send-draft-chat-submission";
import { useChatStatus } from "@/lib/stores/base";
import { useLastMessageId } from "@/lib/stores/hooks-base";
import { cn } from "@/lib/utils";
import { useStableChatInput } from "@/providers/chat-input-provider";
import { type PhaseGateData, usePhaseGate } from "./phase-gate-provider";

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
 *
 * AND WHAT THE CHECKLIST WAS STILL MISSING. It sat in a nested <details> inside
 * a scroll area, read-only, under a headline and a paragraph that restated the
 * count. A founder could see "BLOCKED, 1 could not be assessed, 4 more open" and
 * still not tell which criteria pass, or do anything about one that does not.
 * So the open body IS the checklist now, grouped by what the founder can do
 * about each row (answer it here, or go and collect evidence), with a status
 * strip on the closed row so "which pass" is visible without opening anything.
 * Grouping is by the criterion's `closure`, never by the judge's label
 * (Incident 3), and an offline-only row never offers an on-the-spot answer to
 * a number only fieldwork can produce (Incident 2).
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
 *
 * NOW THE FALLBACK, NOT THE NORMAL SHAPE. When the gaps line up with the
 * criteria (`gapsByCriterion`) each one is printed on its own checklist row.
 * This flat list is what shows when they do not (an older verdict with no ids,
 * or a gap whose criterion the definition no longer carries), so the whole open
 * set is on screen either way (Incident 3).
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
      <p className="font-medium text-sm">
        {`${view.obstacle?.heading ?? "What is missing"}: ${view.gaps.length} of ${view.coverage.criteria} criteria`}
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
          <p className="mt-1 text-sm">
            {progress.opened.map(humanizeCriterionId).join(", ")}
          </p>
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
          {progress.closed.map(humanizeCriterionId).join(", ")}
        </p>
      ) : null}
      {progress.stillOpen.length > 0 ? (
        <p className="text-foreground/75 text-xs">
          <span className="font-medium">Still open:</span>{" "}
          {progress.stillOpen.map(humanizeCriterionId).join(", ")}
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
 * wall of identical text sitting on top of the regression above it.
 *
 * ONLY WHEN THE ROWS CANNOT SAY IT. With the checklist drawn, every repeat is
 * already annotated on its own row ("blocked 18 of 18 attempts"), so this
 * sentence would state the same counts a second time, with raw criterion ids
 * where the rows have names. The card renders it only for a verdict whose rows
 * are not drawn.
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
 * One fill per state, for the closed row's strip. The three assessed states use
 * the same tokens as the text tones above. Not-evaluable is HOLLOW and unscored
 * is a faint solid, so "the gate could not tell" and "the gate was not asked"
 * stay apart from each other and from "not met" without relying on hue alone.
 * The strip is `aria-hidden`: the count beside it carries every state in words.
 */
const STATE_SEGMENT: Record<ChecklistState, string> = {
  met: "bg-state-met",
  partial: "bg-state-partial",
  unmet: "bg-state-unmet",
  "not-evaluable": "border border-foreground/40",
  unscored: "bg-foreground/15",
};

/**
 * ONE SEGMENT PER CRITERION, IN DEFINITION ORDER (`describeStatusStrip` never
 * sorts). The count of segments is the phase's own: phases define 8 to 10
 * criteria, so nothing here assumes eight.
 */
function StatusStripBar({
  strip,
}: {
  strip: Extract<StatusStrip, { available: true }>;
}) {
  return (
    <span
      aria-hidden="true"
      className="flex @[500px]:w-48 w-20 shrink-0 gap-0.5"
    >
      {strip.segments.map((segment) => (
        <span
          className={cn(
            "h-1.5 flex-1 rounded-full",
            STATE_SEGMENT[segment.state]
          )}
          key={segment.id}
        />
      ))}
    </span>
  );
}

/**
 * "Plan how to find out" asks the assistant for help; it asserts nothing, so it
 * is a fixed request (like a follow-up suggestion) and carries no
 * `targetCriterionId`: an "Answering: ..." label on it would claim the founder
 * had answered the criterion.
 */
function planRequestText(title: string): string {
  return `Help me plan how to get real evidence for "${title}": who to talk to, what to ask, and what result would count.`;
}

/**
 * THE TWO THINGS A FOUNDER CAN DO FROM A ROW, wired to the composer.
 *
 * "Answer" and "Report what you found" arm a target on the composer (a chip
 * above the editor, and a label on the next message) and put the cursor there;
 * they send nothing and put nothing in the message text. "Plan how to find out"
 * sends at once, with a fixed sentence, because it asks the assistant for help
 * rather than asserting a fact and so needs nothing typed.
 *
 * THE SEND IS THE COMPOSER'S OWN. It is built with `buildDraftChatSubmission`
 * and sent through `useSendDraftChatSubmission`, the code `coreSubmitLogic`
 * uses, so the request carries its assistant message id, the pending
 * placeholder, the parallel-group fields and the founder's multi-model
 * selection. `followup-suggestions.tsx` sends none of those, and a reply with no
 * placeholder has nowhere to render.
 *
 * ONE CLICK, ONE REQUEST, ACROSS EVERY SENDER. The chat status turns busy a
 * frame or two after `sendMessage` runs, so a second click, or Enter in the
 * composer, in that window would send again. The send flight in
 * `send-draft-chat-submission.ts` is set in the same tick as the send and
 * cleared when the request settles; the button reads it (disabled while it is
 * set) and the click checks it again synchronously. The tool selection is not
 * carried: a founder who has deep research switched on for their own next
 * message did not ask for it here.
 *
 * FOCUS GOES TO THE EDITOR after the send, where the composer refocuses after
 * its own (not on mobile). The button disables itself the moment it is pressed,
 * and a focused control that disables strands keyboard and screen-reader focus
 * on nothing.
 *
 * THIS HOOK LIVES IN `ChecklistBody`, not in the card, on purpose: it reads the
 * composer's context, which changes as the founder types, and everything above
 * the rows (the verdict, the strip, the diff) must not be recomputed for that.
 */
function useCriterionActions({
  chatId,
  phaseKey,
}: {
  chatId: string;
  phaseKey: string;
}) {
  // The narrow context: the full `useChatInput` value changes as the founder
  // types, and would re-render every checklist row with each keystroke.
  const {
    editorRef,
    setCriterionTarget,
    selectedModelId,
    selectedModelSelection,
  } = useStableChatInput();
  const status = useChatStatus();
  const lastMessageId = useLastMessageId();
  const sendDraftChatSubmission = useSendDraftChatSubmission(chatId);
  const { inFlight: sending, isInFlight: isSendInFlight } =
    useSendFlight(chatId);
  const isMobile = useIsMobile();

  const canSend = (status === "ready" || status === "error") && !sending;

  return {
    canSend,
    target(row: GroupedChecklistRow) {
      setCriterionTarget({
        phaseKey,
        criterionId: row.id,
        closure: row.closure,
      });
      // Always, on mobile too: the founder asked to answer, and the keyboard is
      // how they do it.
      editorRef.current?.focus();
    },
    planFieldwork(row: GroupedChecklistRow) {
      if (!canSend || isSendInFlight()) {
        return;
      }
      const { message, requestSpecs } = buildDraftChatSubmission({
        attachments: [],
        input: planRequestText(humanizeCriterionId(row.id)),
        normalizedSelectedModel: normalizeSelectedModel({
          selectedModelId,
          selectedModelSelection,
        }),
        parallelResponsesEnabled: config.features.parallelResponses,
        parentMessageId: lastMessageId,
        selectedTool: null,
        targetCriterionId: null,
      });
      // The send flight starts when this returns, so a send that throws leaves
      // the buttons enabled.
      sendDraftChatSubmission({ message, requestSpecs });
      // Where the composer refocuses after its own send, and not where it does
      // not: on mobile that would raise the keyboard over a reply that is
      // about to stream in.
      if (!isMobile) {
        editorRef.current?.focus();
      }
    },
  };
}

type CriterionActions = ReturnType<typeof useCriterionActions>;

const ACTION_BUTTON = "h-7 px-2.5 text-xs";

/**
 * WHAT A ROW OFFERS DEPENDS ON ITS CLOSURE, never on the judge's label.
 *
 * In-conversation: say it here. Offline-only: there is nothing honest to type
 * until the fieldwork is done, so the choices are to report the result of
 * fieldwork already done, to get help planning it, or to record the finding as
 * a fact on the Facts screen (a founder-asserted fact, ADR-0003). Nothing here
 * advances a phase; only the gate does that.
 */
function RowActions({
  actions,
  projectId,
  row,
}: {
  actions: CriterionActions;
  projectId: string;
  row: GroupedChecklistRow;
}) {
  const title = humanizeCriterionId(row.id);
  if (row.closure === "in-conversation") {
    return (
      <Button
        aria-label={`Answer: ${title}`}
        className={ACTION_BUTTON}
        onClick={() => actions.target(row)}
        size="sm"
        type="button"
        variant="outline"
      >
        Answer
      </Button>
    );
  }
  return (
    <>
      <Button
        aria-label={`Report what you found: ${title}`}
        className={ACTION_BUTTON}
        onClick={() => actions.target(row)}
        size="sm"
        type="button"
        variant="outline"
      >
        Report what you found
      </Button>
      <Button
        aria-label={`Plan how to find out: ${title}`}
        className={ACTION_BUTTON}
        disabled={!actions.canSend}
        onClick={() => actions.planFieldwork(row)}
        size="sm"
        type="button"
        variant="outline"
      >
        Plan how to find out
      </Button>
      <Link
        aria-label={`Record as a fact: ${title}`}
        className="inline-flex h-7 items-center justify-center rounded-sm text-foreground/75 text-xs underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        href={`/project/${projectId}/facts`}
      >
        Record as a fact
      </Link>
    </>
  );
}

/**
 * ONE OPEN CRITERION: its state in words, its name, what is missing, and what
 * the founder can do about it.
 *
 * The glyph is decoration (`aria-hidden`); the status word beside it is the
 * information, and it is one of five that never share a string, so "could not
 * be assessed" and "not scored on this attempt" cannot be read as "not met".
 *
 * THE LINE UNDER THE NAME IS THE GAP, NOT THE DEFINITION, when the gate named
 * one for this criterion: "Missing: ..." is a finding about the founder's work
 * and the description is only what the criterion is. A row with no aligned gap
 * (an advisory criterion in a BLOCK, or a verdict whose gaps did not line up)
 * shows the description instead, so it is never a bare title.
 */
function CriterionRow({
  actions,
  gap,
  projectId,
  row,
  wentBackwards,
}: {
  actions: CriterionActions;
  gap: string | null;
  projectId: string;
  row: GroupedChecklistRow;
  wentBackwards: boolean;
}) {
  const tone = STATE_TONE[row.state];
  return (
    <li className="min-w-0 py-2">
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span aria-hidden="true" className={cn("w-3 shrink-0 text-sm", tone)}>
          {STATE_MARK[row.state]}
        </span>
        <span className="font-medium text-sm">
          {humanizeCriterionId(row.id)}
        </span>
        <span className={cn("text-xs", tone)}>{row.label}</span>
        {row.doesNotBlock ? (
          <span className="text-foreground/75 text-xs">does not block</span>
        ) : null}
        {wentBackwards ? (
          <span className="rounded-full border border-destructive-edge bg-destructive-surface px-2 py-0.5 font-medium text-destructive-on-surface text-xs">
            went backwards
          </span>
        ) : null}
        {row.repeat ? (
          <span className="text-foreground/75 text-xs">
            blocked {row.repeat.blocked} of {row.repeat.of} attempts
          </span>
        ) : null}
      </p>
      {/*
        THE WHOLE GAP, NEVER CLAMPED. A clamp hides the tail of a finding behind
        a tooltip that touch and keyboard cannot reach, and Incident 3 is that the
        founder is shown the whole open set.
      */}
      <p className="mt-0.5 text-foreground/75 text-xs">
        {gap ? `Missing: ${gap}` : row.description}
      </p>
      {/*
        ONE LINE OF ACTIONS UNDER THE TEXT, wrapping only when the card is too
        narrow for them. Side-by-side with the text they stacked three buttons
        and made a row about 110px tall, so two rows filled the capped region.
      */}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <RowActions actions={actions} projectId={projectId} row={row} />
      </div>
    </li>
  );
}

/**
 * THE CHECKLIST, GROUPED BY WHAT THE FOUNDER CAN DO.
 *
 * Through seven refusals the founder never saw what they were being judged
 * against, and once they could, a flat list of eight still did not say which of
 * the open ones they could close from where they sit. So: criteria they can
 * answer in this conversation, criteria that need evidence from outside it, and
 * the met ones squeezed to one line, because a met criterion needs no action and
 * should not push an open one off a small screen.
 *
 * "NEEDS EVIDENCE FROM OUTSIDE THIS CHAT" is a property of the criterion, and
 * it holds whatever label the judge gave it. "You have not said this" and
 * "nobody could say this yet" have opposite remedies, and asking for the second
 * is what produced a gate demanding four rubric scores from a founder with no
 * interviews (Incident 2).
 *
 * IT DRAWS NO ROWS FOR A VERDICT THAT NEVER RAN: the caller only mounts this
 * for an available checklist, and `describeCriterionChecklist` returns an arm
 * with no `rows` at all when nothing was scored.
 */
function ChecklistBody({
  chatId,
  gaps,
  groups,
  phaseKey,
  progress,
  projectId,
}: {
  chatId: string;
  gaps: ReadonlyMap<string, string> | null;
  groups: ChecklistGroups;
  phaseKey: string;
  /**
   * The latest attempt's diff. Its `closed` and `opened` hold criterion IDS
   * (`describeAttemptSeries`), so they match a row by `row.id`: a "newly met"
   * mark on a met row and a "went backwards" mark on an open one.
   */
  progress: AttemptProgress | null;
  projectId: string;
}) {
  const actions = useCriterionActions({ chatId, phaseKey });
  const closedIds = new Set(progress?.closed ?? []);
  const openedIds = new Set(progress?.opened ?? []);
  const open = [
    { heading: "You can answer these now", rows: groups.answerNow },
    {
      heading: "Needs evidence from outside this chat",
      rows: groups.needsEvidence,
    },
  ];
  return (
    <div className="mt-3 space-y-3">
      {open.map((group) =>
        group.rows.length > 0 ? (
          <div key={group.heading}>
            <h3 className="font-medium text-sm">{group.heading}</h3>
            <ul className="divide-y">
              {group.rows.map((row) => (
                <CriterionRow
                  actions={actions}
                  gap={gaps?.get(row.id) ?? null}
                  key={row.id}
                  projectId={projectId}
                  row={row}
                  wentBackwards={openedIds.has(row.id)}
                />
              ))}
            </ul>
          </div>
        ) : null
      )}
      {groups.met.length > 0 ? (
        <p className="text-sm">
          <span aria-hidden="true" className="text-state-met">
            ✓
          </span>{" "}
          <span className="font-medium text-state-met">Met:</span>{" "}
          {groups.met
            .map(
              (row) =>
                `${humanizeCriterionId(row.id)}${closedIds.has(row.id) ? " (newly met)" : ""}`
            )
            .join(", ")}
        </p>
      ) : null}
    </div>
  );
}

/**
 * THE ONE LINE THE CLOSED CARD SHOWS.
 *
 * It has to survive on its own, so the two arms that carry no list say what
 * they are rather than quoting `reason` (which on `none-scored` is a plumbing
 * message, not a finding about the work). Everywhere else it is the headline,
 * else the first named gap, else the gate's "named nothing" note. When the
 * checklist is drawn the open card does not repeat the headline (the strip and
 * the rows say it); when it is not, the open card prints it, whole.
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
 * THE CLOSED ROW, which is also the one control that opens the card.
 *
 * THE WHOLE ROW IS THE CONTROL: a phone thumb should not have to find a 12px
 * chevron. The name a screen reader hears is the row's text, so the sr-only
 * lead says what the row is. It is ONE button and nothing inside it is
 * interactive: the strip and the count are text, and the row actions live in the
 * open region, outside the toggle.
 */
function VerdictRow({
  expanded,
  line,
  onToggle,
  regionId,
  standing,
  strip,
  title,
  view,
}: {
  expanded: boolean;
  line: string | null;
  onToggle: () => void;
  regionId: string;
  standing: AttemptStandingView;
  strip: StatusStrip;
  title: string;
  view: AssessedView;
}) {
  const wentBackwards = standing.progress?.opened.length ?? 0;
  return (
    <button
      aria-controls={regionId}
      aria-expanded={expanded}
      className="flex w-full shrink-0 cursor-pointer items-start gap-2 rounded-lg p-3 text-left hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onToggle}
      type="button"
    >
      <span className="grid min-w-0 flex-1 grid-cols-1 gap-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="sr-only">Gate verdict: </span>
          <Badge variant={STATUS_VARIANT[view.status]}>{view.label}</Badge>
          <span className="font-medium text-sm">{title}</span>
          {/*
            WHICH REFUSAL THIS IS. Seven of them arrived looking identical and
            standalone, and that identity is why the seventh read as pushback
            rather than as position in a sequence. Null, never "Attempt 0",
            before the gate has run.
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
            Shown at every breakpoint. It is the only signal that this card may
            be describing an EARLIER turn, and a founder reading a refusal needs
            to know whether it judged what they just said.
          */}
          {view.pending ? (
            <span className="text-foreground/75 text-xs italic">
              {view.pending.marker}
            </span>
          ) : null}
        </span>
        {/*
          LINE 2: WHICH CRITERIA PASS, WITHOUT OPENING ANYTHING. The strip is
          decoration for sighted readers (`aria-hidden`), the visible count is
          hidden from a screen reader in favour of the sr-only sentence that
          names every state, and the headline keeps whatever room is left and
          truncates. No strip at all when nothing was scored: "0 of 8 met" would
          be a result the gate never produced.
        */}
        {strip.available || line ? (
          <span className="flex min-w-0 items-center gap-2">
            {strip.available ? (
              <>
                <StatusStripBar strip={strip} />
                <span
                  aria-hidden="true"
                  className="shrink-0 whitespace-nowrap font-medium text-xs tabular-nums"
                >
                  {strip.label}
                </span>
                <span className="sr-only">{strip.spoken} </span>
              </>
            ) : null}
            {line ? (
              <span className="min-w-0 flex-1 truncate text-sm">{line}</span>
            ) : null}
          </span>
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
  );
}

/**
 * THE TWO VERDICTS THAT ARE NOT FINDINGS, each in its own sentence.
 *
 * THE GATE NEVER RAN. `failClosedVerdict` returns `perCriterion: []` and
 * `missing: [reason]`, so listing `missing` here would tell a founder that one
 * specific thing is missing when in truth nothing was judged and every criterion
 * is still pending. It is a plumbing failure wearing a refusal's clothes, and it
 * gets its own sentence instead.
 */
function VerdictNotices({ view }: { view: AssessedView }) {
  if (view.coverage.kind === "none-scored") {
    return (
      <p className="mt-3 rounded border border-dashed p-2 text-sm">
        <span className="font-medium">
          The gate could not assess this phase.
        </span>{" "}
        No criterion was scored, so this is not a judgement of your work —
        nothing above tells you what to change. Send another message and it will
        try again.
      </p>
    );
  }
  if (view.coverage.kind === "unreadable") {
    return (
      <p className="mt-3 rounded border border-dashed p-2 text-sm">
        <span className="font-medium">This verdict can no longer be read.</span>{" "}
        The decision above was stored, but its detail no longer matches the
        shape this app expects — so the absence of a list below is a reading
        failure, not a clean bill of health.
      </p>
    );
  }
  return null;
}

/**
 * WHY THERE IS NO CHECKLIST, when there is not one and nothing above said so.
 *
 * Not for the fail-closed and unreadable arms, whose notices already say it, and
 * not for a `judge-incomplete` verdict: its obstacle note ("did not return a
 * usable judgement") is the same fact in the gate's own words, and stating it
 * twice is noise. What is left is a verdict that scored something and still has
 * no rows (the judge's ids matched none of this phase's criteria).
 */
function ChecklistAbsence({
  checklist,
  view,
}: {
  checklist: CriterionChecklist;
  view: AssessedView;
}) {
  if (
    checklist.available ||
    view.coverage.kind !== "scored" ||
    view.obstacle?.kind === "judge-incomplete"
  ) {
    return null;
  }
  return <p className="mt-2 text-foreground/75 text-sm">{checklist.note}</p>;
}

/**
 * WHAT THIS STATE IS, AND WHAT CLOSES IT.
 *
 * The rows are a set of findings with no instruction attached, and for
 * `fieldwork-required` the correct instruction is the opposite of the obvious
 * one: do NOT try to answer these, build the instrument. The WHOLE note is
 * printed, not its first sentence: the later sentences are the remedy
 * ("Restating it plainly is often all this needs", "The next real step is the
 * instrument"), and cutting them keeps the diagnosis and drops the cure. Only
 * for a verdict that scored something.
 */
function VerdictFootnotes({ view }: { view: AssessedView }) {
  if (view.coverage.kind !== "scored") {
    return null;
  }
  return (
    <>
      {view.noGapNote ? (
        <p className="mt-2 text-foreground/75 text-sm">{view.noGapNote}</p>
      ) : null}
      {view.obstacle ? (
        <p className="mt-2 text-foreground/75 text-sm">{view.obstacle.note}</p>
      ) : null}
    </>
  );
}

/**
 * WHERE EACH GAP IS PRINTED.
 *
 * When the gaps line up with the criteria AND each lands on an open row, every
 * gap is on its own row and the flat list would say it twice (`carried`). If
 * they do not (no ids on an older verdict, or an id the definition no longer
 * has) the rows show the criterion's description instead, and the flat list,
 * with the headline above it, carries the whole open set — Incident 3 is that
 * the founder is never shown only some of it.
 */
function placeGaps({
  groups,
  obstacle,
  view,
}: {
  groups: ChecklistGroups | null;
  obstacle: GateObstacle | null;
  view: AssessedView;
}): { carried: boolean; gaps: ReadonlyMap<string, string> | null } {
  const gaps = gapsByCriterion(view.gaps, obstacle);
  if (!(groups && gaps)) {
    return { carried: false, gaps: null };
  }
  const openIds = new Set(
    [...groups.answerNow, ...groups.needsEvidence].map((row) => row.id)
  );
  const carried = [...gaps.keys()].every((id) => openIds.has(id));
  return { carried, gaps: carried ? gaps : null };
}

/**
 * THE GATE'S OWN SENTENCE ABOVE THE ROWS, or null.
 *
 * `view.headline` is `view.reason` with its trailing restatement of the gap list
 * cut off, so the gaps below are not the same sentences a second time. Its
 * `summary` half is the gate's own sentence about WHICH rule fired and how much
 * else is open, and the status words on the rows do not say that, so it is shown
 * even when the rows carry every gap. The `instead-of-list` arm is different:
 * the reason IS the gap and nothing else, so when the rows carry the gap it is
 * the same sentence twice, and it is shown only when they do not (`GapList`
 * prints nothing on that arm).
 */
function headlineText(view: AssessedView, carried: boolean): string | null {
  const { headline } = view;
  if (headline.kind === "summary") {
    return headline.text;
  }
  if (headline.kind === "instead-of-list" && !carried) {
    return headline.text;
  }
  return null;
}

/**
 * THE OPEN REGION: what moved, the checklist, the notes that frame it, then
 * where to go next. Hidden, not unmounted, while closed (`hidden`), so the
 * toggle's `aria-controls` always points at something.
 *
 * REGRESSIONS COME FIRST, right under the phase line and above the checklist.
 * "Newly unmet — this went backwards" is the one fact a founder cannot
 * reconstruct from the conversation, so nothing sits in front of it.
 */
function VerdictDetails({
  card: { carried, checklist, gaps, groups, headline, standing, view },
  chatId,
  data,
  expanded,
  projectId,
  regionId,
}: {
  card: VerdictCard;
  chatId: string;
  data: PhaseGateData;
  expanded: boolean;
  projectId: string;
  regionId: string;
}) {
  return (
    <section
      aria-label="Verdict details"
      aria-live="off"
      className="max-h-[min(30dvh,20rem)] min-h-0 overflow-y-auto overscroll-contain border-t px-3 pt-2 pb-3 md:max-h-[min(40dvh,24rem)]"
      hidden={!expanded}
      id={regionId}
    >
      <p className="text-foreground/75 text-xs">
        Phase {data.order} of {data.total}
      </p>

      <AttemptDiff progress={standing.progress} />

      {headline ? <p className="mt-2 text-sm">{headline}</p> : null}

      <VerdictNotices view={view} />

      {carried ? null : <GapList view={view} />}

      {/*
        ONLY WHEN THERE ARE NO ROWS TO SAY IT. With the checklist drawn, each
        repeat is on its own row, and this sentence would restate those counts
        with raw ids.
      */}
      {groups ? null : <RepeatNote note={standing.repeatNote} />}

      {/*
        THE CHECKLIST IS THE BODY. Where it cannot be drawn (nothing scored, an
        unreadable verdict, a `judge-incomplete` one) the flat open set above
        stands in for it and `ChecklistAbsence` says why, unless something
        already did.
      */}
      {groups ? (
        <ChecklistBody
          chatId={chatId}
          gaps={gaps}
          groups={groups}
          phaseKey={data.phaseKey}
          progress={standing.progress}
          projectId={projectId}
        />
      ) : null}
      <ChecklistAbsence checklist={checklist} view={view} />

      <VerdictFootnotes view={view} />

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
  );
}

/**
 * EVERYTHING THE CARD DERIVES FROM THE GATE PAYLOAD, in one pure place so it can
 * be memoised on that payload.
 *
 * All of these read the SAME payload in the same call, so the attempt number,
 * the diff and the checklist cannot describe a different verdict from the one
 * badged at the top. A verdict that is not assessed carries none of the rest:
 * there is nothing to derive a checklist from.
 */
type CardView =
  | {
      kind: "unassessed";
      view: Extract<GateVerdictView, { assessed: false }>;
    }
  | {
      kind: "verdict";
      /** Every gap is on its own row, so the flat list is not printed. */
      carried: boolean;
      checklist: CriterionChecklist;
      /** Gap text per criterion id, set only when `carried`. */
      gaps: ReadonlyMap<string, string> | null;
      /** Null when the checklist cannot be drawn. */
      groups: ChecklistGroups | null;
      /** The gate's own sentence above the rows, or null. */
      headline: string | null;
      /** The one truncated line on the closed row. */
      line: string | null;
      standing: AttemptStandingView;
      strip: StatusStrip;
      view: AssessedView;
    };

type VerdictCard = Extract<CardView, { kind: "verdict" }>;

function deriveCardView(
  data: PhaseGateData,
  assessment: RailAssessment
): CardView {
  const view = describeGateVerdict({
    assessment,
    criteriaAssessed: data.criteriaAssessed,
    decision: data.decision,
    missing: data.missing,
    nextQuestion: data.nextQuestion,
    obstacle: data.obstacle,
    reason: data.reason,
    total: data.total,
    perCriterion: data.perCriterion,
    verdictReadable: data.verdictReadable,
    workflowComplete: data.workflowComplete,
  });
  if (!view.assessed) {
    return { kind: "unassessed", view };
  }
  const standing = describeAttemptStanding({
    attemptCount: data.attemptCount,
    ledger: data.ledger,
    criteria: data.criteria,
  });
  const checklist = describeCriterionChecklist({
    criteria: data.criteria,
    perCriterion: data.perCriterion,
    repeats: standing.repeats,
    verdictReadable: data.verdictReadable,
    obstacle: data.obstacle,
  });
  const groups = checklist.available
    ? groupChecklistRows(checklist.rows)
    : null;
  const { carried, gaps } = placeGaps({
    groups,
    obstacle: data.obstacle,
    view,
  });
  return {
    kind: "verdict",
    carried,
    checklist,
    gaps,
    groups,
    headline: headlineText(view, carried),
    line: summaryLine(view),
    standing,
    strip: describeStatusStrip(checklist),
    view,
  };
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
 * So the card is TWO LINES until asked: badge, phase, attempt and a chevron,
 * then the status strip with its count and the headline on a single truncated
 * line. Everything the card ever said is still there, in a region under the
 * row, capped at `min(30dvh, 20rem)` (`min(40dvh, 24rem)` from `md`, where the
 * pane has the height for it) with its own scrollbar — the cap is relative to
 * the viewport, so the transcript keeps most of a phone's pane and the
 * composer is never pushed out. The cap is the ceiling, not the floor: the card
 * and its region are flex items that may shrink (`min-h-0`), so on a landscape
 * phone the region gives way before the composer does.
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
 *
 * THIS COMPONENT DOES NOT READ THE COMPOSER. It re-renders when the gate payload
 * changes, not on every keystroke; the row actions that need the composer's
 * context are a layer down (`ChecklistBody`).
 */
export function GateVerdictCard({
  chatId,
  projectId,
  className,
}: {
  chatId: string;
  projectId: string;
  className?: string;
}) {
  const gate = usePhaseGate();
  const [expanded, setExpanded] = useState(false);
  const regionId = useId();
  const data = gate?.data ?? null;
  const assessment = gate?.wait.kind ?? "idle";
  // Keyed on the payload (the provider keeps its identity between polls that
  // return the same state) and on the wait, so nothing is re-derived for a
  // render that changed neither.
  const card = useMemo(
    () => (data ? deriveCardView(data, assessment) : null),
    [assessment, data]
  );
  if (!(data && card)) {
    return null;
  }

  // NOT ASSESSED IS NOT A VERDICT, so it does not get a verdict's card. A
  // founder who has not been judged yet must not see a bordered panel that
  // looks like a ruling — the only thing worth saying is that the gate has not
  // looked, and only while something is actually pending.
  if (card.kind === "unassessed") {
    const { view } = card;
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

  const { line, standing, strip, view } = card;
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
        <VerdictRow
          expanded={expanded}
          line={line}
          onToggle={() => setExpanded((open) => !open)}
          regionId={regionId}
          standing={standing}
          strip={strip}
          title={data.title}
          view={view}
        />
        <VerdictDetails
          card={card}
          chatId={chatId}
          data={data}
          expanded={expanded}
          projectId={projectId}
          regionId={regionId}
        />
      </div>
    </output>
  );
}
