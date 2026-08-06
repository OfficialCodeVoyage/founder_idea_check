"use client";

// App-level persistence/confirmation state for a single chat store.

import type { UIMessage } from "ai";
import type { StateCreator } from "zustand";
import type { ChatMessage } from "@/lib/ai/types";
import type { ParallelRequestSpec } from "@/lib/draft-chat-submission";
import type { StoreState as BaseChatStoreState } from "@/lib/stores/base";

export interface PendingChatConfirmation {
  message: ChatMessage;
  projectId: string | null;
  requestSpecs: ParallelRequestSpec[];
}

export type ChatPersistenceAugmentedState<UM extends UIMessage> =
  BaseChatStoreState<UM> & {
    isChatPersisted: boolean;
    pendingChatConfirmation: PendingChatConfirmation | null;
    clearPendingChatConfirmation: () => void;
    setChatPersisted: (isPersisted: boolean) => void;
    setPendingChatConfirmation: (
      pendingConfirmation: PendingChatConfirmation | null
    ) => void;
  };

export const withChatPersistence =
  <UI_MESSAGE extends UIMessage, T extends BaseChatStoreState<UI_MESSAGE>>(
    creator: StateCreator<T, [], []>,
    options: { initialIsChatPersisted?: boolean } = {}
  ): StateCreator<T & ChatPersistenceAugmentedState<UI_MESSAGE>, [], []> =>
  (set, get, api) => {
    const base = creator(set, get, api);
    const originalReset = base.reset;

    return {
      ...base,
      isChatPersisted: options.initialIsChatPersisted ?? false,
      pendingChatConfirmation: null,
      clearPendingChatConfirmation: () => {
        set({ pendingChatConfirmation: null } as Partial<
          T & ChatPersistenceAugmentedState<UI_MESSAGE>
        >);
      },
      reset: () => {
        originalReset();
        set({
          isChatPersisted: false,
          pendingChatConfirmation: null,
        } as Partial<T & ChatPersistenceAugmentedState<UI_MESSAGE>>);
      },
      setChatPersisted: (isPersisted) => {
        set({ isChatPersisted: isPersisted } as Partial<
          T & ChatPersistenceAugmentedState<UI_MESSAGE>
        >);
      },
      setPendingChatConfirmation: (pendingChatConfirmation) => {
        set({ pendingChatConfirmation } as Partial<
          T & ChatPersistenceAugmentedState<UI_MESSAGE>
        >);
      },
    };
  };
