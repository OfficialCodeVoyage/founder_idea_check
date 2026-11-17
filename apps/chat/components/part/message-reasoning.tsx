"use client";
import { memo } from "react";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import { Shimmer } from "@/components/ai-elements/shimmer";

interface MessageReasoningProps {
  content: string;
  isLoading: boolean;
}

function PureReasoningPart({ isLoading, content }: MessageReasoningProps) {
  // NO TOGGLE WITHOUT TEXT. Claude's 5.5 models think on every turn, and
  // unless a request asks for a summary (`display: "summarized"`, sent only
  // for a `-reasoning` variant) the thinking streams with empty text. Rendered
  // as a part, that was a "Reasoning" toggle with nothing inside on every
  // interview turn. While it streams, a plain "Thinking..." line keeps the
  // pause visible; once the turn moves on, an empty part shows nothing.
  // Decided here, at render time, so messages already stored that way are
  // covered too.
  if (content.trim().length === 0) {
    return isLoading ? (
      <Shimmer className="mb-2 text-sm" duration={1}>
        Thinking...
      </Shimmer>
    ) : null;
  }
  return (
    <Reasoning className="mb-2" isStreaming={isLoading}>
      <ReasoningTrigger data-testid="message-reasoning-toggle" />
      <ReasoningContent data-testid="message-reasoning">
        {content}
      </ReasoningContent>
    </Reasoning>
  );
}

export const ReasoningPart = memo(PureReasoningPart);
