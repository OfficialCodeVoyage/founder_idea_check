"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useSyncExternalStore } from "react";
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
import { useChatActions, useChatStatus } from "@/lib/stores/base";
import { useAddMessageToTree } from "@/lib/stores/hooks-threads";
import { useChatInput } from "@/providers/chat-input-provider";
import { useTRPC } from "@/trpc/react";

/**
 * A SEND THE CHAT STATUS HAS NOT CAUGHT UP WITH YET, shared by every sender.
 *
 * The chat status is mirrored into the store by an effect (and, when batching
 * is on, an animation frame), so for a frame or two after `sendMessage` runs
 * every reader still sees `ready`. Two senders in that window both send: the
 * gate card's "Plan how to find out" and then Enter in the composer, or the
 * other way round. Each sender's own check (the composer's `submission`, the
 * card's disabled button) reads a render-time status and cannot see the other.
 *
 * So the flight is a module-level fact keyed on the chat id, set synchronously
 * the moment a send returns, and cleared when the chat status has gone busy and
 * come back (`settleSendFlight`). A send that never turns the status busy (a
 * dropped request) would otherwise block the chat for good, so an unseen flight
 * also expires on its own after `UNSEEN_FLIGHT_MS`.
 */
type SendFlight = { sawBusy: boolean };

const UNSEEN_FLIGHT_MS = 1500;
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

function beginSendFlight(chatId: string) {
  const flight: SendFlight = { sawBusy: false };
  sendFlights.set(chatId, flight);
  notifyFlightListeners();
  setTimeout(() => {
    if (sendFlights.get(chatId) === flight && !flight.sawBusy) {
      sendFlights.delete(chatId);
      notifyFlightListeners();
    }
  }, UNSEEN_FLIGHT_MS);
}

function settleSendFlight(chatId: string, busy: boolean) {
  const flight = sendFlights.get(chatId);
  if (!flight) {
    return;
  }
  if (busy) {
    flight.sawBusy = true;
    return;
  }
  if (flight.sawBusy) {
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
 * It starts a send flight (above) once the send has returned, so a send that
 * throws leaves nothing locked. It does NOT refuse a send itself: the composer
 * clears its editor after calling this, and a silent refusal would lose what the
 * founder typed. Callers check `isSendInFlight` first. A provisional chat starts
 * no flight: it changes the route and remounts the chat, so the flight would
 * outlive the store whose status settles it.
 *
 * Returns true when it started a provisional chat (the route changes and the
 * caller's own refocus has already been done through `onStarted`).
 */
export function useSendDraftChatSubmission(chatId: string) {
  const status = useChatStatus();
  const busy = status === "submitted" || status === "streaming";
  useEffect(() => {
    settleSendFlight(chatId, busy);
  }, [busy, chatId]);

  const send = useDispatchDraftChatSubmission(chatId);
  return useCallback(
    (submission: Parameters<typeof send>[0]): boolean => {
      const startedProvisionalChat = send(submission);
      if (!startedProvisionalChat) {
        beginSendFlight(chatId);
      }
      return startedProvisionalChat;
    },
    [chatId, send]
  );
}

function useDispatchDraftChatSubmission(chatId: string) {
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
