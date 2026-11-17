"use client";

import { DefaultChatTransport } from "ai";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useSaveMessageMutation } from "@/hooks/chat-sync-hooks";
import { useCompleteDataPart } from "@/hooks/use-complete-data-part";
import { getStreamErrorToastContent } from "@/lib/ai/stream-errors";
import type { ChatMessage } from "@/lib/ai/types";
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

function textLength(message: ChatMessage) {
  let length = 0;
  for (const part of message.parts) {
    if (part.type === "text" || part.type === "reasoning") {
      length += part.text.length;
    }
  }
  return length;
}

// Whether copy `a` of a reply got further than copy `b` of the same
// generation. While a reply streams its parts are only appended or updated in
// place, and its text parts only grow, so more parts, or as many parts and
// more text, means further along.
function isFurtherAlong(a: ChatMessage, b: ChatMessage) {
  if (a.parts.length !== b.parts.length) {
    return a.parts.length > b.parts.length;
  }
  return textLength(a) > textLength(b);
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

  // The reply each running resume started from, by message id, for `onFinish`.
  // An entry belongs to one resume and goes when that resume settles.
  const resumedRepliesRef = useRef(new Map<string, { reply: ChatMessage }>());
  // `onFinish` is built before `useChat` returns `setMessages`, so it reads it here.
  const setMessagesRef = useRef<UseChatHelpers<ChatMessage>["setMessages"]>(
    () => undefined
  );

  const { resumeStream, setMessages } = useChat<ChatMessage>({
    experimental_throttle: 100,
    id,
    // TODO: this is a special "snapshot" value in the store that is only updated
    // on store init + sibling switch. Once the store can guarantee up-to-date
    // messages at ChatSync remount time, we can likely remove this override.
    messages: threadInitialMessages,
    generateId: generateUUID,
    onFinish: ({
      message: finished,
      messages,
      isAbort,
      isDisconnect,
      isError,
    }) => {
      // A RESUME THAT STREAMED NOTHING HANDS BACK A MESSAGE THAT DOES NOT EXIST.
      // Since ai 6.0.323 a resumed stream is rebuilt from empty state under
      // `generateId()`, not seeded with the last message. The one-shot stream
      // that `app/(chat)/api/chat/[id]/stream/route.ts::appendMessageResponse`
      // returns (a reload after the stream already ended) carries only a
      // transient `data-appendMessage` part and no `start` chunk, so the SDK
      // never writes anything into the chat and finishes with
      // `{ id: <fresh uuid>, role: "assistant", parts: [] }`. Adding that to the
      // tree would put a phantom root sibling next to the real reply, and
      // `saveChatMessage` would append it to the cached list. The real message
      // arrives through `hooks/use-complete-data-part.ts`, so there is nothing
      // to record here.
      //
      // The fix is this guard, not a `start` chunk on that response: with one,
      // the SDK writes a part-less copy over the stored message in the chat
      // (its metadata and any text it already had vanish until the data part
      // lands) and finishes with that part-less copy under the REAL id, which
      // `addMessageToTree` would then store over the real one. A message the
      // SDK never wrote into `messages` and that has no parts is never a real
      // reply: every real stream writes its message at `start`.
      if (
        finished.role === "assistant" &&
        finished.parts.length === 0 &&
        !messages.some((existing) => existing.id === finished.id)
      ) {
        return;
      }

      // A RESUME THAT ENDS EARLY NEVER MAKES THE REPLY ON SCREEN SHORTER.
      // The replay rebuilds the message from empty state (the SDK no longer
      // seeds it with the stored parts), so a Stop, an error or a dropped fetch
      // ends it with whatever the buffered chunks had rebuilt so far, under the
      // real id. The reply the resume started from goes back into the chat only
      // when it got further than that replay (`isFurtherAlong`); otherwise the
      // replay's own copy is recorded below, as for a stream that was never
      // resumed. Either way a Stop below marks the reply as stopped.
      //
      // The two copies are built the same way, so comparing them is fair: the
      // database never holds a resumable row with parts.
      // `app/(chat)/api/chat/route.ts::executeChatRequest` saves the assistant
      // row empty when the turn begins, and `persistFinishedAssistantMessage`
      // writes the parts and clears `activeStreamId` in one `updateMessage`
      // transaction when it ends. So a reply resumed after a reload is an empty
      // placeholder, which never wins (putting it back used to blank the text
      // after a Stop until the next reload), and a reply that has parts is a
      // copy this tab recorded from an earlier stream of the same generation.
      // The server's own save of the generation shows on the next load from the
      // database; nothing re-syncs a live chat from it (`saveChatMessage`
      // writes only the client cache).
      const resumedFrom = resumedRepliesRef.current.get(finished.id)?.reply;
      const stored =
        resumedFrom &&
        (isAbort || isDisconnect || isError) &&
        isFurtherAlong(resumedFrom, finished)
          ? resumedFrom
          : undefined;
      if (stored && !isAbort) {
        setMessagesRef.current((current) =>
          current.map((existing) =>
            existing.id === stored.id ? stored : existing
          )
        );
        return;
      }

      // A STOP LEAVES THE MESSAGE LOOKING ALIVE. Its `finish` chunk never came,
      // so the client's copy keeps the `activeStreamId` it got at `start` and
      // the chat is `ready`: a tool part still in `input-streaming` kept its
      // "Creating" spinner until a reload (live QA, re-check 5). Note the Stop on
      // the message itself, in the chat's state and in the tree copy, so a
      // renderer can tell it from a page about to reattach to a live stream.
      const recorded = stored ?? finished;
      const message: ChatMessage = isAbort
        ? {
            ...recorded,
            metadata: { ...recorded.metadata, streamStopped: true },
          }
        : recorded;
      if (isAbort) {
        setMessagesRef.current((current) =>
          current.map((existing) => {
            if (existing.id !== message.id) {
              return existing;
            }
            return stored
              ? message
              : {
                  ...existing,
                  metadata: { ...existing.metadata, streamStopped: true },
                };
          })
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
    const reply = lastMessageRef.current;
    if (!reply) {
      return;
    }
    // One entry per resume: it is dropped when this resume settles, whether it
    // streamed, found no stream (204) or failed, and a newer resume of the same
    // message that replaced it keeps its own.
    const entry = { reply };
    resumedRepliesRef.current.set(reply.id, entry);
    resumeStream().finally(() => {
      if (resumedRepliesRef.current.get(reply.id) === entry) {
        resumedRepliesRef.current.delete(reply.id);
      }
    });
  }, [resumeKey, resumeStream]);

  useCompleteDataPart();

  return null;
}
