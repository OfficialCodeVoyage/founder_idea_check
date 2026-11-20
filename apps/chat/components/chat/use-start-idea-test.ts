"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { resolveOpeningModelId } from "@/lib/ai/chat-seed-model";
import type { ChatMessage } from "@/lib/ai/types";
import { config } from "@/lib/config";
import { buildDraftChatSubmission } from "@/lib/draft-chat-submission";
import {
  addPendingAssistantMessages,
  createParallelRequestBody,
} from "@/lib/parallel-chat-requests";
import { useCustomChatStoreApi } from "@/lib/stores/custom-store-provider";
import { useChatPersistenceActions } from "@/lib/stores/hooks-chat-persistence";
import { useAddMessageToTree } from "@/lib/stores/hooks-threads";
import { useStableChatInput } from "@/providers/chat-input-provider";
import { useChatModels } from "@/providers/chat-models-provider";
import { useTRPC } from "@/trpc/react";
import { deriveIdeaName } from "./idea-name";

/**
 * START AN IDEA TEST FROM THE HOME SCREEN: create a project for the idea, then
 * send the founder's description as the first message of that project's first
 * chat. The phases and the gate run only in a project chat, so a plain chat
 * started here would be an ungated chatbot wearing the idea test's clothes.
 *
 * The send is `lib/start-provisional-chat.ts::useStartProvisionalChat`, step
 * for step and in the same order, with one difference: that hook takes the
 * project from the current URL, and on `/` there is none until
 * `project.create` returns. So the new project's id is passed in here, and the
 * URL moves to `/project/<id>/chat/<chatId>` the way the project home's own
 * first message moves it. The chat id is the home route's provisional one, so
 * the runtime that sent the message is the one the new route finds.
 *
 * The model is the project interviewer (`config.ai.workflows.chat`), the model a
 * project's first chat opens in (`app/(chat)/chat-route-host.tsx` through
 * `resolveOpeningModelId`), not the home screen's last pick. The composer is
 * moved to it too, so the founder's next message goes to the same model.
 *
 * Resolves `true` once the message is sent. Throws when the project cannot be
 * created, before anything is sent, so the caller can keep the text.
 */
export function useStartIdeaTest(chatId: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const storeApi = useCustomChatStoreApi<ChatMessage>();
  const { setPendingChatConfirmation } = useChatPersistenceActions();
  const addMessageToTree = useAddMessageToTree();
  const { handleModelChange, selectedModelId } = useStableChatInput();
  const { getModelById } = useChatModels();
  const { mutateAsync: createProject } = useMutation(
    trpc.project.create.mutationOptions()
  );

  return useCallback(
    async (description: string): Promise<boolean> => {
      const input = description.trim();
      if (!input) {
        return false;
      }

      const { id: projectId } = await createProject({
        name: deriveIdeaName(input),
      });
      queryClient.invalidateQueries({
        queryKey: trpc.project.list.queryKey(),
      });

      const modelId =
        resolveOpeningModelId({
          isKnownModel: (id) => Boolean(getModelById(id)),
          projectInterviewerModelId: config.ai.workflows.chat,
        }) ?? selectedModelId;

      const { message, requestSpecs } = buildDraftChatSubmission({
        attachments: [],
        input,
        normalizedSelectedModel: modelId,
        parallelResponsesEnabled: false,
        parentMessageId: null,
        selectedTool: null,
      });
      const primaryRequest = requestSpecs[0];

      // Read after the await, not from render: the store's `sendMessage` can
      // still be its placeholder on a page that has just mounted.
      const sendMessage = storeApi.getState().sendMessage;
      if (!(sendMessage && primaryRequest)) {
        // The project exists but nothing was sent. Open it, so the founder
        // can send the idea from the project's own composer.
        window.location.assign(`/project/${projectId}`);
        return false;
      }

      setPendingChatConfirmation({ message, projectId, requestSpecs });
      handleModelChange(modelId);
      sendMessage(message, {
        body: { ...createParallelRequestBody(primaryRequest, true), projectId },
      });
      addMessageToTree(message);
      addPendingAssistantMessages({ addMessageToTree, message, requestSpecs });

      window.history.pushState(
        null,
        "",
        `/project/${projectId}/chat/${chatId}`
      );
      return true;
    },
    [
      addMessageToTree,
      chatId,
      createProject,
      getModelById,
      handleModelChange,
      queryClient,
      selectedModelId,
      setPendingChatConfirmation,
      storeApi,
      trpc,
    ]
  );
}
