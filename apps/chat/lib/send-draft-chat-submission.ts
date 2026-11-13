"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
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
import { useStableChatInput } from "@/providers/chat-input-provider";
import { useTRPC } from "@/trpc/react";

/**
 * A SEND THE CHAT STATUS HAS NOT CAUGHT UP WITH YET, shared by every sender.
 *
 * Two senders in the window after `sendMessage` runs both send: the gate card's
 * "Plan how to find out" and then Enter in the composer, or the other way
 * round. Each sender's own check (the composer's `submission`, the card's
 * disabled button) reads a render-time status, and that status still reads
 * `ready` for a frame or two after the send.
 *
 * WHY THIS READS NO STATUS. No synchronous source of the real status is
 * reachable from here. The AI SDK's `Chat` instance flips to "submitted"
 * synchronously inside `sendMessage`, but it is private to `useChat` (which
 * returns helpers, not the instance), and the store mirrors `status` through an
 * effect and, with batching on, an animation frame
 * (`lib/stores/base/use-chat.ts`), so `getState().status` is exactly as late as
 * the render-time value. What IS synchronous and exact is the promise
 * `sendMessage` returns: the SDK resolves it when the request, and any
 * automatic follow-up, has finished or failed (`makeRequest` handles its own
 * errors and always returns). So the flight is that promise, keyed on the chat
 * id: set in the same tick as the send, cleared the moment the request settles.
 * No timer, no expiry, and nothing to get out of step with the status mirror.
 *
 * A FLIGHT BELONGS TO ONE CHAT INSTANCE. The promise can outlive the chat it
 * stands for: a sibling switch or a store re-init replaces the AI SDK `Chat`,
 * and a fetch that stalls keeps its promise pending until reload. So each
 * flight records its `owner` — the `sendMessage` that made the send, whose
 * identity is per `Chat` instance — and `ChatSync`, which owns that instance,
 * releases the owner's flight when the instance is replaced or unmounted
 * (`releaseSendFlight`). A stalled send can then block only the instance it
 * was sent through, never the one that replaced it.
 */
type SendFlight = { owner: unknown };

const sendFlights = new Map<string, SendFlight>();
const flightListeners = new Set<() => void>();

function notifyFlightListeners() {
  for (const listener of flightListeners) {
    listener();
  }
}

function subscribeToFlights(listener: () => void) {
  flightListeners.add(listener);
  return () => {
    flightListeners.delete(listener);
  };
}

/**
 * Track one send until its promise settles. A later send for the same chat
 * replaces the flight, so an earlier promise settling cannot clear it.
 *
 * `finally` hands back a promise that rejects with the same reason, so a send
 * that rejects is reported once, as it was before the flight existed.
 */
function trackSendFlight(
  chatId: string,
  sent: Promise<unknown>,
  owner: unknown
) {
  const flight: SendFlight = { owner };
  sendFlights.set(chatId, flight);
  notifyFlightListeners();
  sent.finally(() => {
    if (sendFlights.get(chatId) === flight) {
      sendFlights.delete(chatId);
      notifyFlightListeners();
    }
  });
}

/**
 * Drop `chatId`'s flight if `owner` (a `Chat` instance's `sendMessage`) made
 * it. Called by `ChatSync` when that instance is replaced or unmounted; a
 * flight a newer instance has started since is left alone.
 */
export function releaseSendFlight(chatId: string, owner: unknown) {
  if (sendFlights.get(chatId)?.owner === owner) {
    sendFlights.delete(chatId);
    notifyFlightListeners();
  }
}

/** Synchronous, for a click or key handler that must not send twice. */
export function isSendInFlight(chatId: string): boolean {
  return sendFlights.has(chatId);
}

/** Reactive, for a button that should look disabled while a send is in flight. */
export function useSendInFlight(chatId: string): boolean {
  return useSyncExternalStore(
    subscribeToFlights,
    () => sendFlights.has(chatId),
    () => false
  );
}

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
 * It starts a send flight (above) from the promise `sendMessage` returns, after
 * the call, so a send that throws leaves nothing locked. It does NOT refuse a
 * send itself: the composer clears its editor after calling this, and a silent
 * refusal would lose what the founder typed. Callers check `isSendInFlight`
 * first. A provisional chat (a project's first message) gets a flight too:
 * `startProvisionalChat` returns its send's promise. Without it two Enters
 * before the status mirror leaves `ready` sent the first message twice — two
 * user turns and two charged replies.
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
  const { handleModelChange } = useStableChatInput();

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

      const provisional = startProvisionalChat({
        message,
        onStarted,
        requestSpecs,
      });
      if (provisional) {
        trackSendFlight(chatId, provisional, sendMessage);
        return true;
      }

      if (!primaryRequest) {
        trackSendFlight(
          chatId,
          sendMessage(
            message,
            currentRoute.projectId
              ? { body: { projectId: currentRoute.projectId } }
              : undefined
          ),
          sendMessage
        );
        addMessageToTree(message);
        return false;
      }

      trackSendFlight(
        chatId,
        sendMessage(message, {
          body: {
            ...createParallelRequestBody(primaryRequest, true),
            projectId: currentRoute.projectId ?? undefined,
          },
        }),
        sendMessage
      );

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
