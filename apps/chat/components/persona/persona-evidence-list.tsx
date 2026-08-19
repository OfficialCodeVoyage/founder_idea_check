import {
  EyeIcon,
  type LucideIcon,
  MessageSquareQuoteIcon,
  SparklesIcon,
} from "lucide-react";
import type { EvidenceKind, PersonaEvidence } from "@/lib/personas/types";
import { cn } from "@/lib/utils";

/**
 * EVIDENCE IS NEVER HIDDEN BEHIND A DISCLOSURE.
 *
 * The obvious design is a tidy persona card with a "show sources" toggle. That
 * design is wrong for this product: the moment provenance is one click away, the
 * card reads exactly like every other AI-generated persona — confident,
 * complete, unsourced — and the founder stops checking. The sources are printed
 * inline, under the value, every time, because the whole claim of this artifact
 * is that each line came from somebody.
 */

const EVIDENCE_ICON: Record<EvidenceKind, LucideIcon> = {
  observation: EyeIcon,
  quote: MessageSquareQuoteIcon,
  assumption: SparklesIcon,
};

/**
 * The assumption row is deliberately the odd one out: dashed border, muted
 * text, and the word [Assumption] spelled out rather than implied by a colour.
 * Colour alone would be invisible to a colour-blind founder and would vanish
 * entirely in a screenshot pasted into a deck.
 */
const EVIDENCE_STYLE: Record<EvidenceKind, string> = {
  observation: "border-border",
  quote: "border-border",
  assumption: "border-dashed border-muted-foreground/40",
};

const EVIDENCE_LABEL: Record<EvidenceKind, string> = {
  observation: "Observed",
  quote: "Quote",
  assumption: "[Assumption]",
};

export function PersonaEvidenceList({
  evidence,
  className,
}: {
  evidence: readonly PersonaEvidence[];
  className?: string;
}) {
  if (evidence.length === 0) {
    return null;
  }

  return (
    <ul className={cn("mt-2 space-y-1.5", className)}>
      {evidence.map((item) => {
        const Icon = EVIDENCE_ICON[item.kind];
        return (
          <li
            className={cn(
              "flex gap-2 rounded-md border border-l-2 bg-muted/30 px-2.5 py-1.5 text-xs",
              EVIDENCE_STYLE[item.kind]
            )}
            key={`${item.kind}|${item.source}|${item.quote}`}
          >
            <Icon
              aria-hidden="true"
              className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
            />
            <div className="min-w-0 space-y-0.5">
              <p className="text-foreground/90 italic">“{item.quote}”</p>
              <p className="text-muted-foreground">
                <span className="sr-only">{EVIDENCE_LABEL[item.kind]} — </span>
                {item.kind === "assumption" ? "[Assumption] " : null}
                {item.source}
                {item.when ? `, ${item.when}` : null}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
