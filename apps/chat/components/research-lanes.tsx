import { Ban, CircleCheck, CircleSlash, Minus } from "lucide-react";
import type {
  LaneOutcome,
  LaneReport,
} from "@/tools/platform/research-updates-schema";

/**
 * WHICH SOURCES RAN, AND WHICH REFUSED — RENDERED WITH THE RESULT.
 *
 * On 2026-08-21 a founder asked for a source-cited study with primary sources,
 * received zero citations, and had to ask "why am I only seeing Y Combinator?"
 * to find out that four of six lanes were switched off. Every one of those
 * refusals already existed as a written sentence — `decideProviderGate` and the
 * sidecar's adapters produce them — and every one of them stopped at a log line.
 *
 * THIS IS THE PHASE GATE'S PRINCIPLE, APPLIED WHERE IT WAS NOT: a refusal that
 * names its reason is the product. The gate refuses a founder and tells them the
 * specific gap; research refused itself and told them nothing.
 *
 * The refusal `detail` is rendered WHOLE and unedited. Those strings are written
 * for a human on purpose — one names the credential a lane is missing, another
 * names the exact parameter Arctic Shift needs instead — and truncating them
 * removes the only part a reader can act on.
 */

const ICON: Record<LaneOutcome["kind"], typeof CircleCheck> = {
  returned: CircleCheck,
  "found-nothing": CircleSlash,
  refused: Ban,
  "not-attempted": Minus,
};

/**
 * Each arm's own sentence. Deliberately NOT a shared template with a number
 * plugged in: "searched, found nothing" and "never asked" are different facts,
 * and the whole failure this component exists to fix was a template that
 * rendered both of them, and a crash, as the same zero.
 */
function outcomeLabel(outcome: LaneOutcome): string {
  switch (outcome.kind) {
    case "returned": {
      const signals = `${outcome.signals} signal${outcome.signals === 1 ? "" : "s"}`;
      // A per-search lane limit left some out: say how many were kept and how
      // many were not, and why, so "3 signals" never reads as all the lane had.
      return outcome.leftOut
        ? `${signals} kept, ${outcome.leftOut.count} left out (${outcome.leftOut.because})`
        : signals;
    }
    case "found-nothing":
      return "searched, found nothing";
    case "refused":
      return `refused (${outcome.failureKind})`;
    default:
      return "never asked";
  }
}

function LaneRow({ lane }: { lane: LaneReport }) {
  const Icon = ICON[lane.outcome.kind];
  const refused = lane.outcome.kind === "refused";

  return (
    <li className="flex items-start gap-2 py-1">
      <Icon
        aria-hidden="true"
        className={
          refused
            ? "mt-0.5 size-3.5 shrink-0 text-destructive-on-surface"
            : "mt-0.5 size-3.5 shrink-0 text-muted-foreground"
        }
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-xs">
          <span className="font-medium text-foreground">{lane.label}</span>
          <span className="text-muted-foreground"> — </span>
          <span className="text-muted-foreground">
            {outcomeLabel(lane.outcome)}
          </span>
        </span>
        {lane.outcome.kind === "refused" && (
          // Verbatim. Never summarised, never clamped to a line count.
          <p className="text-muted-foreground text-xs leading-relaxed">
            {lane.outcome.detail}
          </p>
        )}
      </div>
    </li>
  );
}

export function ResearchLanes({ lanes }: { lanes: LaneReport[] }) {
  if (lanes.length === 0) {
    // No lane report was streamed — an older transcript, or a run that died
    // before reaching the search tool. Invented rows would be a claim about
    // gate decisions that were never made.
    return null;
  }

  const ran = lanes.filter(
    (lane) =>
      lane.outcome.kind === "returned" || lane.outcome.kind === "found-nothing"
  ).length;

  return (
    <div className="w-full rounded-lg border p-3">
      <p className="pb-1 font-medium text-foreground text-xs">
        {`${ran} of ${lanes.length} ${lanes.length === 1 ? "source" : "sources"} ran`}
      </p>
      <ul className="divide-y divide-border/60">
        {lanes.map((lane) => (
          <LaneRow key={lane.sourceId} lane={lane} />
        ))}
      </ul>
    </div>
  );
}
