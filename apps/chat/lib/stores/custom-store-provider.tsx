"use client";

import type { UIMessage } from "@ai-sdk/react";
import { type PropsWithChildren, useContext, useRef } from "react";
import { devtools, subscribeWithSelector } from "zustand/middleware";
import { createStore } from "zustand/vanilla";
import {
  Provider as ChatProvider,
  ChatStoreContext,
  createChatStoreCreator,
} from "@/lib/stores/base";

import {
  type ChatPersistenceAugmentedState,
  withChatPersistence,
} from "./with-chat-persistence";
import {
  type DataStreamAugmentedState,
  withDataStream,
} from "./with-data-stream";
import {
  type PartsAugmentedState,
  withMessageParts,
} from "./with-message-parts";
import { type ThreadAugmentedState, withThreads } from "./with-threads";
import { withTracing } from "./with-tracing";

export type CustomChatStoreState<UI_MESSAGE extends UIMessage = UIMessage> =
  ChatPersistenceAugmentedState<UI_MESSAGE> &
    DataStreamAugmentedState<UI_MESSAGE> &
    PartsAugmentedState<UI_MESSAGE> &
    ThreadAugmentedState<UI_MESSAGE>;

const ENABLE_TRACING_ON_DEV = false;
export function createCustomChatStore<TMessage extends UIMessage = UIMessage>(
  initialMessages: TMessage[] = [],
  options: { initialIsChatPersisted?: boolean } = {}
) {
  return createStore<CustomChatStoreState<TMessage>>()(
    devtools(
      subscribeWithSelector(
        withTracing(
          withChatPersistence(
            withDataStream(
              withThreads(
                withMessageParts(
                  createChatStoreCreator<TMessage>(initialMessages)
                )
              )
            ),
            {
              initialIsChatPersisted: options.initialIsChatPersisted,
            }
          ),
          process.env.NODE_ENV === "development" && ENABLE_TRACING_ON_DEV
        )
      ),
      { name: "chat-store" }
    )
  );
}

export type CustomChatStoreApi<TMessage extends UIMessage = UIMessage> =
  ReturnType<typeof createCustomChatStore<TMessage>>;

export function useCustomChatStoreApi<
  TMessage extends UIMessage = UIMessage,
>() {
  const store = useContext(ChatStoreContext);
  if (!store) {
    throw new Error("useChatStoreApi must be used within Provider");
  }
  return store as CustomChatStoreApi<TMessage>;
}

type ChatProviderProps = Parameters<typeof ChatProvider>[0];

export function CustomStoreProvider<TMessage extends UIMessage = UIMessage>({
  initialMessages = [],
  children,
  store,
}: PropsWithChildren<{
  initialMessages?: TMessage[];
  store?: CustomChatStoreApi<TMessage>;
}> &
  Omit<ChatProviderProps, "initialMessages" | "store">) {
  const storeRef = useRef<CustomChatStoreApi<TMessage> | null>(null);

  if (storeRef.current === null) {
    storeRef.current =
      store ?? createCustomChatStore<TMessage>(initialMessages);
  }

  return (
    <ChatProvider<TMessage>
      initialMessages={initialMessages}
      store={storeRef.current || undefined}
    >
      {children}
    </ChatProvider>
  );
}
