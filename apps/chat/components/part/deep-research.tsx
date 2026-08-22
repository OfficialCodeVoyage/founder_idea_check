"use client";

import type { ChatMessage } from "@/lib/ai/types";
import { useMessageResearchUpdatePartByToolCallId } from "@/lib/stores/hooks-message-parts";
import { ResearchLanes } from "../research-lanes";
import { mergeLaneReports } from "../research-run-summary";
import { ResearchUpdates } from "./message-annotations";

type DeepResearchPart = Extract<
  ChatMessage["parts"][number],
  { type: "tool-deepResearch" }
>;

/**
 * A CRASH AND A REFUSAL ARE NOT THE SAME EVENT.
 *
 * `problem` is deep research failing: something threw, or it was handed a
 * conversation with nothing in it. `unavailable` is deep research WORKING —
 * the preflight in deep-research.ts read the source gate, found that no lane on
 * this deployment can run, and said so with each source's reason attached
 * rather than promising the founder a sourced study it cannot produce.
 *
 * Painting the second in the same red as the first teaches a founder to read a
 * correct, actionable answer as a defect. See app/globals.css for the two
 * contrast-checked token pairs.
 */
type Outcome = { kind: "problem" | "unavailable"; text: string };

function getOutcome(part: DeepResearchPart): Outcome | null {
  if (part.state !== "output-available") {
    return null;
  }
  if (part.output.format === "problem") {
    return { kind: "problem", text: part.output.answer };
  }
  if (part.output.format === "unavailable") {
    return { kind: "unavailable", text: part.output.answer };
  }
  return null;
}

export function DeepResearch({
  messageId,
  part,
}: {
  messageId: string;
  part: DeepResearchPart;
}) {
  const { toolCallId } = part;
  const researchUpdates = useMessageResearchUpdatePartByToolCallId(
    messageId,
    toolCallId
  );

  const updates = researchUpdates.map((u) => u.data);
  const lanes = mergeLaneReports(updates);
  // The lane report is rendered on its own, below, rather than as another step
  // in the timeline: the founder had to ASK which sources ran, so it does not
  // go behind the expander.
  const timeline = updates.filter((update) => update.type !== "lanes");

  const outcome = getOutcome(part);

  return (
    <div className="flex w-full flex-col gap-3">
      <ResearchUpdates updates={timeline} />
      <ResearchLanes lanes={lanes} />
      {outcome?.kind === "problem" && (
        /*
          WAS: `bg-destructive/10 text-destructive-foreground`, i.e. white text
          — sized for the SOLID destructive fill — over a 10% tint of it. On a
          white page that composites to #FFFFFF on #FDECEC: 1.14:1, against a
          WCAG AA floor of 4.5:1. The founder's first complaint was that the
          error was the least legible thing in the block.
        */
        <div className="rounded-lg border border-destructive-edge bg-destructive-surface p-3 text-destructive-on-surface text-sm">
          <p className="whitespace-pre-wrap">{outcome.text}</p>
        </div>
      )}
      {outcome?.kind === "unavailable" && (
        <div className="rounded-lg border border-notice-edge bg-notice-surface p-3 text-notice-on-surface text-sm">
          <p className="whitespace-pre-wrap">{outcome.text}</p>
        </div>
      )}
    </div>
  );
}
