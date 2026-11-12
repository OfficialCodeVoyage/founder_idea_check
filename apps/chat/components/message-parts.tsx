"use client";

import {
  isDataUIPart,
  isReasoningUIPart,
  isStaticToolUIPart,
  isTextUIPart,
  isToolUIPart,
} from "ai";
import { memo } from "react";
import { isDeadStreamAnnouncement } from "@/lib/artifacts/text/salvage";
import {
  useDeadDocumentCardsCoverAnnouncement,
  useMessagePartByPartIdx,
  useMessagePartTypesById,
} from "@/lib/stores/hooks-message-parts";
import { DynamicToolPart } from "./part/dynamic-tool";
import { ReasoningPart } from "./part/message-reasoning";
import { TextMessagePart } from "./part/text-message-part";
import { ToolPart } from "./part/tool-part";

interface MessagePartsProps {
  isLoading: boolean;
  isReadonly: boolean;
  messageId: string;
}

/**
 * The text the route stores for a document call that died mid-input. Its
 * headline and detail are already printed by the call's card, so a message with
 * such a card leaves it out of the transcript (the stored and model-facing text
 * is untouched). It is also what an old stored message carries, which is why
 * this is decided at render time rather than at the source.
 */
function DeadStreamAnnouncementPart({
  messageId,
  text,
  isLoading,
}: {
  messageId: string;
  text: string;
  isLoading: boolean;
}) {
  const cardsSayIt = useDeadDocumentCardsCoverAnnouncement(messageId);
  if (cardsSayIt) {
    return null;
  }
  return <TextMessagePart isLoading={isLoading} text={text} />;
}

// Render a single part by index with minimal subscriptions
function PureMessagePart({
  messageId,
  partIdx,
  isReadonly,
  isLoading,
}: {
  messageId: string;
  partIdx: number;
  isReadonly: boolean;
  isLoading: boolean;
}) {
  const part = useMessagePartByPartIdx(messageId, partIdx);

  if (isTextUIPart(part)) {
    if (isDeadStreamAnnouncement(part.text)) {
      return (
        <DeadStreamAnnouncementPart
          isLoading={isLoading}
          messageId={messageId}
          text={part.text}
        />
      );
    }
    return <TextMessagePart isLoading={isLoading} text={part.text} />;
  }

  if (isReasoningUIPart(part)) {
    return <ReasoningPart content={part.text} isLoading={isLoading} />;
  }

  if (isDataUIPart(part)) {
    return null;
  }

  if (isToolUIPart(part)) {
    if (isStaticToolUIPart(part)) {
      return (
        <ToolPart isReadonly={isReadonly} messageId={messageId} part={part} />
      );
    }
    return (
      <DynamicToolPart
        isReadonly={isReadonly}
        messageId={messageId}
        part={part}
      />
    );
  }

  return null;
}

const MessagePart = memo(PureMessagePart);

function PureMessageParts({
  messageId,
  isLoading,
  isReadonly,
}: MessagePartsProps) {
  const types = useMessagePartTypesById(messageId);

  return types.map((t, i) => {
    return (
      <MessagePart
        isLoading={isLoading && i === types.length - 1}
        isReadonly={isReadonly}
        // biome-ignore lint/suspicious/noArrayIndexKey: we only have index at this point
        key={`message-${messageId}-${t}-${i}`}
        messageId={messageId}
        partIdx={i}
      />
    );
  });
}

export const MessageParts = memo(PureMessageParts);
