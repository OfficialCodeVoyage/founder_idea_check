import { RefreshCcw } from "lucide-react";
import { useCallback } from "react";
import { toast } from "sonner";
import { Action } from "@/components/ai-elements/actions";
import type { ChatMessage } from "@/lib/ai/types";
import { getRetryMessageInput } from "@/lib/chat-tree-actions";
import {
  useChatActions,
  useChatStatus,
  useChatStoreApi,
} from "@/lib/stores/base";
import { useChatModels } from "@/providers/chat-models-provider";
import { useDefaultModel } from "@/providers/default-model-provider";

export function RetryButton({
  messageId,
  className,
}: {
  messageId: string;
  className?: string;
}) {
  const { setMessages, sendMessage } = useChatActions<ChatMessage>();
  const chatStore = useChatStoreApi<ChatMessage>();
  const status = useChatStatus();
  const { getModelById } = useChatModels();
  // Checked against the catalog and the anonymous list by the layout.
  const defaultModel = useDefaultModel();

  const handleRetry = useCallback(() => {
    if (!sendMessage) {
      toast.error("Cannot retry this message");
      return;
    }

    const retryInput = getRetryMessageInput({
      messageId,
      messages: chatStore.getState().messages,
      isKnownModel: (modelId) => Boolean(getModelById(modelId)),
      fallbackModelId: defaultModel,
    });

    if (!retryInput.ok) {
      if (retryInput.reason === "message_not_found") {
        toast.error("Cannot find the message to retry");
      } else if (retryInput.reason === "parent_not_found") {
        toast.error("Cannot find the user message to retry");
      } else {
        toast.error("Parent message is not from user");
      }
      return;
    }

    setMessages(retryInput.messagesBeforeRetry);

    // Resend the parent user message
    sendMessage(retryInput.message, {});

    toast.success("Retrying message...");
  }, [
    sendMessage,
    messageId,
    setMessages,
    chatStore,
    getModelById,
    defaultModel,
  ]);

  if (status === "streaming" || status === "submitted") {
    return null;
  }

  return (
    <Action
      className={`h-7 w-7 text-muted-foreground hover:bg-accent hover:text-accent-foreground p-0${
        className ? ` ${className}` : ""
      }`}
      onClick={handleRetry}
      tooltip="Retry"
    >
      <RefreshCcw className="h-3.5 w-3.5" />
    </Action>
  );
}
