// This file has hooks that are enabled by the with-message-parts middleware

import equal from "fast-deep-equal";
import { shallow } from "zustand/shallow";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { isMarkedDeadInputStream } from "@/lib/artifacts/text/salvage";
import { documentToolTypes } from "@/tools/platform/documents/types";
import type { ChatMessage } from "../ai/types";
import {
  type CustomChatStoreState,
  useCustomChatStoreApi,
} from "./custom-store-provider";

const artifactToolTypes = [...documentToolTypes, "tool-deepResearch"] as const;

function usePartsStore<T>(
  selector: (store: CustomChatStoreState<ChatMessage>) => T,
  equalityFn?: (a: T, b: T) => boolean
): T {
  const store = useCustomChatStoreApi<ChatMessage>();
  if (!store) {
    throw new Error("usePartsStore must be used within ChatStoreProvider");
  }
  return useStoreWithEqualityFn(store, selector, equalityFn);
}

export const useMessagePartTypesById = (
  messageId: string
): ChatMessage["parts"][number]["type"][] =>
  usePartsStore((state) => state.getMessagePartTypesById(messageId), shallow);

export function useMessagePartByPartIdx(
  messageId: string,
  partIdx: number
): ChatMessage["parts"][number];
export function useMessagePartByPartIdx<
  T extends ChatMessage["parts"][number]["type"],
>(
  messageId: string,
  partIdx: number,
  type: T
): Extract<ChatMessage["parts"][number], { type: T }>;
export function useMessagePartByPartIdx<
  T extends ChatMessage["parts"][number]["type"],
>(messageId: string, partIdx: number, type?: T) {
  const part = usePartsStore((state) =>
    state.getMessagePartByIdx(messageId, partIdx)
  );
  if (type !== undefined && part.type !== type) {
    throw new Error(
      `Part type mismatch for id: ${messageId} at partIdx: ${partIdx}. Expected ${String(type)}, got ${String(
        part.type
      )}`
    );
  }
  return part as unknown as T extends ChatMessage["parts"][number]["type"]
    ? Extract<ChatMessage["parts"][number], { type: T }>
    : ChatMessage["parts"][number];
}

/**
 * WHETHER THE DEAD-DOCUMENT CARDS IN THIS MESSAGE ALREADY SAY WHAT ITS
 * ANNOUNCEMENT TEXT SAYS.
 *
 * The route appends a text part to a turn whose document call died mid-input,
 * so the stored transcript says what was lost; the message also renders a card
 * for each such call (`DeadDocumentStream`) with the same headline and detail
 * and a button for the "To finish it, ask" line. Printing both put the same
 * bold sentence under every card. True only when the message has at least one
 * swept call and EVERY swept call is a document call: a dead call of another
 * kind has no card, so there the announcement is the only explanation and must
 * stay.
 */
export function useDeadDocumentCardsCoverAnnouncement(
  messageId: string
): boolean {
  return usePartsStore((state) => {
    const parts = state.getMessageById(messageId)?.parts ?? [];
    const swept = parts.filter(isMarkedDeadInputStream);
    return (
      swept.length > 0 &&
      swept.every((part) =>
        (documentToolTypes as readonly string[]).includes(part.type)
      )
    );
  });
}

export function useMessageResearchUpdatePartByToolCallId(
  messageId: string,
  toolCallId: string
): Extract<ChatMessage["parts"][number], { type: "data-researchUpdate" }>[] {
  return usePartsStore(
    (state) =>
      state
        .getMessageById(messageId)
        ?.parts.filter((part) => part.type === "data-researchUpdate")
        .filter((part) => part.data.toolCallId === toolCallId) ?? [],
    equal
  );
}

export function useIsLastArtifact(toolCallId: string): boolean {
  return usePartsStore((state) => {
    const messages = state._throttledMessages || state.messages;

    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role !== "assistant") {
        continue;
      }

      for (const part of message.parts) {
        if (
          "toolCallId" in part &&
          (artifactToolTypes as readonly string[]).includes(part.type) &&
          part.state === "output-available"
        ) {
          return part.toolCallId === toolCallId;
        }
      }
    }

    return false;
  });
}
