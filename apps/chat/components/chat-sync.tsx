"use client";

import { DefaultChatTransport } from "ai";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useSaveMessageMutation } from "@/hooks/chat-sync-hooks";
import { useCompleteDataPart } from "@/hooks/use-complete-data-part";
import { getStreamErrorToastContent } from "@/lib/ai/stream-errors";
import type { ChatMessage } from "@/lib/ai/types";
import { releaseSendFlight } from "@/lib/send-draft-chat-submission";
import { type UseChatHelpers, useChat } from "@/lib/stores/base";
import { useChatPersistenceActions } from "@/lib/stores/hooks-chat-persistence";
import { useDataStream } from "@/lib/stores/hooks-data-stream";
import {
  useAddMessageToTree,
  useThreadInitialMessages,
} from "@/lib/stores/hooks-threads";
import { fetchWithErrorHandlers, generateUUID } from "@/lib/utils";
import { useSession } from "@/providers/session-provider";

function isResumableActiveStreamId(activeStreamId: string | null | undefined) {
  return !!(activeStreamId && !activeStreamId.startsWith("pending:"));
}

export function ChatSync({ id }: { id: string }) {
  const { data: session } = useSession();
  const { mutate: saveChatMessage } = useSaveMessageMutation();
  const { setChatPersisted } = useChatPersistenceActions();
  const { setDataStream } = useDataStream();

  const isAuthenticated = !!session?.user;
  const threadInitialMessages = useThreadInitialMessages();
  const addMessageToTree = useAddMessageToTree();
  const hasReportedConfirmationRef = useRef(false);

  const lastMessage = threadInitialMessages.at(-1);
  const lastMessageRef = useRef(lastMessage);
  lastMessageRef.current = lastMessage;
  const activeStreamId = lastMessage?.metadata?.activeStreamId;
  // What would be resumed: this message's stream. A different key (a sibling
  // that is still streaming becoming the last message) is a different resume.
  const resumeKey =
    lastMessage && isResumableActiveStreamId(activeStreamId)
      ? `${lastMessage.id}:${activeStreamId}`
      : null;

  // `onFinish` is built before `useChat` returns `setMessages`, so it reads it here.
  const setMessagesRef = useRef<UseChatHelpers<ChatMessage>["setMessages"]>(
    () => undefined
  );

  const { resumeStream, sendMessage, setMessages } = useChat<ChatMessage>({
    experimental_throttle: 100,
    id,
    // TODO: this is a special "snapshot" value in the store that is only updated
    // on store init + sibling switch. Once the store can guarantee up-to-date
    // messages at ChatSync remount time, we can likely remove this override.
    messages: threadInitialMessages,
    generateId: generateUUID,
    onFinish: ({ message: finished, isAbort }) => {
      // A STOP LEAVES THE MESSAGE LOOKING ALIVE. Its `finish` chunk never came,
      // so the client's copy keeps the `activeStreamId` it got at `start` and
      // the chat is `ready`: a tool part still in `input-streaming` kept its
      // "Creating" spinner until a reload (live QA, re-check 5). Note the Stop on
      // the message itself, in the chat's state and in the tree copy, so a
      // renderer can tell it from a page about to reattach to a live stream.
      const message: ChatMessage = isAbort
        ? {
            ...finished,
            metadata: { ...finished.metadata, streamStopped: true },
          }
        : finished;
      if (isAbort) {
        setMessagesRef.current((messages) =>
          messages.map((existing) =>
            existing.id === message.id
              ? {
                  ...existing,
                  metadata: { ...existing.metadata, streamStopped: true },
                }
              : existing
          )
        );
      }
      addMessageToTree(message);
      saveChatMessage({ message, chatId: id });
    },
    transport: new DefaultChatTransport({
      api: "/api/chat",
      fetch: fetchWithErrorHandlers as typeof fetch,
      prepareSendMessagesRequest({ messages, id: requestId, body }) {
        return {
          body: {
            id: requestId,
            message: messages.at(-1),
            prevMessages: isAuthenticated ? [] : messages.slice(0, -1),
            ...body,
          },
        };
      },
      prepareReconnectToStreamRequest({ id: chatId }) {
        const current = lastMessageRef.current;
        const activeStreamId = current?.metadata?.activeStreamId ?? null;
        const partialMessageId = isResumableActiveStreamId(activeStreamId)
          ? (current?.id ?? null)
          : null;

        return {
          api: `/api/chat/${chatId}/stream${partialMessageId ? `?messageId=${partialMessageId}` : ""}`,
        };
      },
    }),
    onData: (dataPart) => {
      if (
        !hasReportedConfirmationRef.current &&
        dataPart.type === "data-chatConfirmed" &&
        dataPart.data.chatId === id
      ) {
        hasReportedConfirmationRef.current = true;
        setChatPersisted(true);
      }
      setDataStream((ds) =>
        ds ? [...ds, dataPart as (typeof ds)[number]] : []
      );
    },
    onError: (error) => {
      const { message, description } = getStreamErrorToastContent(error);
      toast.error(message, description ? { description } : undefined);
    },
  });

  setMessagesRef.current = setMessages;

  // A SEND FLIGHT DIES WITH ITS CHAT INSTANCE. `sendMessage` is per `Chat`
  // instance, so this cleanup runs when the instance is replaced (a sibling
  // switch, a store re-init) or this component unmounts, and releases the
  // flight that instance's send still holds — a stalled request must not
  // refuse every Enter in the chat that replaced it
  // (`lib/send-draft-chat-submission.ts::releaseSendFlight`).
  useEffect(() => () => releaseSendFlight(id, sendMessage), [id, sendMessage]);

  // RESUME EACH STREAM ONCE, NOT ONCE PER EFFECT RUN.
  //
  // This replaces useChat's own `resume` option, whose effect calls
  // `resumeStream()` every time React runs it. React Strict Mode runs every
  // effect twice on mount in development, so each mid-stream reload sent two
  // identical GETs to /api/chat/<id>/stream. The AI SDK's `makeRequest` cannot
  // overlap with itself: the first request to finish clears `activeResponse`,
  // and the second then reads `activeResponse.state` in its `finally` and
  // throws "Cannot read properties of undefined (reading 'state')", which
  // lights the Next dev issue badge. That read is inside the SDK, so the fix is
  // to never start two resumes of the same stream.
  //
  // A ref survives Strict Mode's simulated remount, so the second run sees the
  // first one's key and returns. A different key still resumes, and the key
  // clears when nothing is resumable so a stream that comes back resumes again.
  const resumedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (resumeKey === null) {
      resumedKeyRef.current = null;
      return;
    }
    if (resumedKeyRef.current === resumeKey) {
      return;
    }
    resumedKeyRef.current = resumeKey;
    resumeStream();
  }, [resumeKey, resumeStream]);

  useCompleteDataPart();

  return null;
}
