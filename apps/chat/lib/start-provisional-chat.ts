"use client";

import type { Route } from "next";
import { useCallback } from "react";
import type { ChatMessage } from "@/lib/ai/types";
import { useCurrentChatRoute } from "@/lib/chat-route";
import type { ParallelRequestSpec } from "@/lib/draft-chat-submission";
import {
  addPendingAssistantMessages,
  createParallelRequestBody,
} from "@/lib/parallel-chat-requests";
import { useCustomChatStoreApi } from "@/lib/stores/custom-store-provider";
import { useChatPersistenceActions } from "@/lib/stores/hooks-chat-persistence";
import { useAddMessageToTree } from "@/lib/stores/hooks-threads";
import { useModelChange } from "@/providers/default-model-provider";
import { useSession } from "@/providers/session-provider";

function getProvisionalChatHref({
  chatId,
  projectId,
  source,
}: {
  chatId: string;
  projectId: string | null;
  source: "home" | "project";
}) {
  if (source === "project") {
    return projectId ? (`/project/${projectId}/chat/${chatId}` as Route) : null;
  }

  return `/chat/${chatId}` as Route;
}

function isInitialRoute(
  route: ReturnType<typeof useCurrentChatRoute>
): route is Extract<
  ReturnType<typeof useCurrentChatRoute>,
  { type: "home" | "projectHome" }
> {
  return route.type === "home" || route.type === "projectHome";
}

export function useStartProvisionalChat(chatId: string) {
  const currentRoute = useCurrentChatRoute();
  const changeModel = useModelChange();
  const { data: session } = useSession();
  const addMessageToTree = useAddMessageToTree();
  const storeApi = useCustomChatStoreApi<ChatMessage>();
  const { setPendingChatConfirmation } = useChatPersistenceActions();

  return useCallback(
    ({
      message,
      onStarted,
      requestSpecs,
    }: {
      message: ChatMessage;
      onStarted?: () => void;
      requestSpecs: ParallelRequestSpec[];
    }): false | { sent: Promise<void>; owner: unknown } => {
      if (!(session?.user && isInitialRoute(currentRoute))) {
        return false;
      }

      const href = getProvisionalChatHref({
        chatId,
        projectId: currentRoute.projectId,
        source: currentRoute.source,
      });

      if (!href) {
        return false;
      }

      const primaryRequest = requestSpecs[0] ?? null;
      const storeState = storeApi.getState();
      const sendMessage = storeState.sendMessage;

      if (!sendMessage) {
        return false;
      }

      setPendingChatConfirmation({
        message,
        projectId: currentRoute.projectId,
        requestSpecs,
      });

      if (primaryRequest) {
        changeModel(primaryRequest.modelId);
      }

      let requestOptions: Parameters<typeof sendMessage>[1] | undefined;

      if (primaryRequest) {
        requestOptions = {
          body: {
            ...createParallelRequestBody(primaryRequest, true),
            projectId: currentRoute.projectId ?? undefined,
          },
        };
      } else if (currentRoute.projectId) {
        requestOptions = {
          body: { projectId: currentRoute.projectId },
        };
      }

      const sent = sendMessage(message, requestOptions);

      addMessageToTree(message);

      addPendingAssistantMessages({
        addMessageToTree,
        message,
        requestSpecs,
      });

      window.history.pushState(null, "", href);
      onStarted?.();

      // The send's own promise and the `sendMessage` that made it, so a caller
      // can hold a send flight on it (`lib/send-draft-chat-submission.ts::
      // trackSendFlight`) under the instance that really sent. A caller's
      // render-time `sendMessage` can still be the store's placeholder on a
      // page that has just mounted. Truthy, so a "did it start" check still
      // reads it as a boolean.
      return { sent, owner: sendMessage };
    },
    [
      addMessageToTree,
      changeModel,
      chatId,
      currentRoute,
      session?.user,
      setPendingChatConfirmation,
      storeApi,
    ]
  );
}
