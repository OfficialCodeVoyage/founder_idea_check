"use client";
import { memo } from "react";
import { config } from "@/lib/config";
import { useChatId, useChatStatus } from "@/lib/stores/base";
import {
  useLastMessageId,
  useMessageMetadataById,
} from "@/lib/stores/hooks-base";
import { Message, MessageContent } from "./ai-elements/message";
import { FollowUpSuggestionsParts } from "./followup-suggestions";
import { MessageActions } from "./message-actions";
import { MessageParts } from "./message-parts";
import { SourcesAnnotations } from "./part/message-annotations";
import type { BaseMessageProps } from "./user-message";

const PureAssistantMessage = ({
  messageId,
  isLoading,
  isReadonly,
}: Omit<BaseMessageProps, "parentMessageId">) => {
  const chatId = useChatId();
  const metadata = useMessageMetadataById(messageId);
  const status = useChatStatus();
  const isLastMessage = useLastMessageId() === messageId;
  // ONLY THE LAST MESSAGE CAN BE THE ONE A STREAM IS BEING REATTACHED TO. A
  // message that died keeps the `activeStreamId` it got at `start` (the
  // `finish` chunk that would have cleared it never came), so "has an id and
  // the chat is `submitted`" alone also matched that dead message the moment
  // the founder pressed "Continue from where it stopped": the user's new
  // message is then the last one and `submitted` is its request, not a
  // reattach. The dead card and its actions vanished for as long as the
  // request was pending and came back only if it failed. It stays on screen
  // now; the new answer arrives in a message of its own below it.
  const isReconnectingToMessageStream =
    isLastMessage && metadata.activeStreamId !== null && status === "submitted";

  if (!chatId || isReconnectingToMessageStream) {
    return null;
  }

  return (
    <Message className="w-full max-w-full items-start py-1" from="assistant">
      <MessageContent className="w-full px-0 py-0 text-left">
        <MessageParts
          isLoading={isLoading}
          isReadonly={isReadonly}
          messageId={messageId}
        />

        <SourcesAnnotations
          key={`sources-annotations-${messageId}`}
          messageId={messageId}
        />

        <MessageActions
          chatId={chatId}
          isLoading={isLoading}
          isReadOnly={isReadonly}
          key={`action-${messageId}`}
          messageId={messageId}
        />
        {isReadonly || !config.ai.tools.followupSuggestions.enabled ? null : (
          <FollowUpSuggestionsParts messageId={messageId} />
        )}
      </MessageContent>
    </Message>
  );
};
export const AssistantMessage = memo(
  PureAssistantMessage,
  (prevProps, nextProps) => {
    if (prevProps.messageId !== nextProps.messageId) {
      return false;
    }
    if (prevProps.isLoading !== nextProps.isLoading) {
      return false;
    }
    if (prevProps.isReadonly !== nextProps.isReadonly) {
      return false;
    }
    return true;
  }
);
