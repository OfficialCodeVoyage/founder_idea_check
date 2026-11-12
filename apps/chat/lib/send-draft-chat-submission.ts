"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "sonner";
import type { ChatMessage } from "@/lib/ai/types";
import { useCurrentChatRoute } from "@/lib/chat-route";
import type { ParallelRequestSpec } from "@/lib/draft-chat-submission";
import {
  addPendingAssistantMessages,
  createParallelRequestBody,
  markParallelRequestSpecsFailed,
  runParallelRequestSpecs,
} from "@/lib/parallel-chat-requests";
import { useStartProvisionalChat } from "@/lib/start-provisional-chat";
import { useChatActions } from "@/lib/stores/base";
import { useAddMessageToTree } from "@/lib/stores/hooks-threads";
import { useChatInput } from "@/providers/chat-input-provider";
import { useTRPC } from "@/trpc/react";

/**
 * SENDING A BUILT SUBMISSION, in one place.
 *
 * This is the half of the composer's submit that comes after
 * `buildDraftChatSubmission` (`multimodal-input.tsx::coreSubmitLogic`), moved
 * here unchanged so the gate card's "Plan how to find out" sends a message
 * exactly as the composer does: the primary request with its assistant message
 * id and parallel-group fields, the pending placeholder for every requested
 * model, the extra parallel requests, and the provisional-chat start for a
 * project's first message. A second copy of this would drift, and a send that
 * skipped the placeholder is a send whose reply has nowhere to render.
 *
 * Returns true when it started a provisional chat (the route changes and the
 * caller's own refocus has already been done through `onStarted`).
 */
export function useSendDraftChatSubmission(chatId: string) {
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const currentRoute = useCurrentChatRoute();
  const startProvisionalChat = useStartProvisionalChat(chatId);
  const { sendMessage } = useChatActions<ChatMessage>();
  const addMessageToTree = useAddMessageToTree();
  const { handleModelChange } = useChatInput();

  return useCallback(
    ({
      message,
      onStarted,
      requestSpecs,
    }: {
      message: ChatMessage;
      onStarted?: () => void;
      requestSpecs: ParallelRequestSpec[];
    }): boolean => {
      const primaryRequest = requestSpecs[0] ?? null;

      if (startProvisionalChat({ message, onStarted, requestSpecs })) {
        return true;
      }

      if (!primaryRequest) {
        sendMessage(
          message,
          currentRoute.projectId
            ? { body: { projectId: currentRoute.projectId } }
            : undefined
        );
        addMessageToTree(message);
        return false;
      }

      sendMessage(message, {
        body: {
          ...createParallelRequestBody(primaryRequest, true),
          projectId: currentRoute.projectId ?? undefined,
        },
      });

      addMessageToTree(message);
      handleModelChange(primaryRequest.modelId);
      addPendingAssistantMessages({
        addMessageToTree,
        message,
        requestSpecs,
      });

      runParallelRequestSpecs({
        chatId,
        message,
        projectId: currentRoute.projectId,
        requestSpecs: requestSpecs.slice(1),
      })
        .then(async (failedRequestSpecs) => {
          if (failedRequestSpecs.length > 0) {
            markParallelRequestSpecsFailed({
              addMessageToTree,
              message,
              requestSpecs: failedRequestSpecs,
            });
            toast.error("Failed to complete all parallel responses");
          }

          await queryClient.invalidateQueries({
            queryKey: trpc.chat.getChatMessages.queryKey({ chatId }),
          });
        })
        .catch(() => {
          toast.error("Failed to complete all parallel responses");
        });
      return false;
    },
    [
      addMessageToTree,
      chatId,
      currentRoute.projectId,
      handleModelChange,
      queryClient,
      sendMessage,
      startProvisionalChat,
      trpc,
    ]
  );
}
