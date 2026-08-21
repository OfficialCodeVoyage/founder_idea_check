"use client";

import { memo } from "react";
import { Chat } from "@/components/chat";
import { DataStreamHandler } from "@/components/data-stream-handler";
import { ArtifactProvider } from "@/hooks/use-artifact";
import type { AppModelId } from "@/lib/ai/app-models";
import type {
  ChatMessage,
  SelectedModelValue,
  UiToolName,
} from "@/lib/ai/types";
import type { ChatRouteSource } from "@/lib/chat-route";
import {
  type CustomChatStoreApi,
  CustomStoreProvider,
} from "@/lib/stores/custom-store-provider";
import type { UIChat } from "@/lib/types/ui-chat";
import { ChatInputProvider } from "@/providers/chat-input-provider";

export const ChatSystem = memo(function PureChatSystem({
  chat,
  id,
  initialMessages,
  isReadonly,
  initialTool = null,
  overrideModelId,
  overrideModelSelection,
  projectId,
  routeSource = projectId ? "project" : "chat",
  runtimeKey,
  store,
}: {
  chat?: UIChat | null;
  id: string;
  initialMessages: ChatMessage[];
  isReadonly: boolean;
  initialTool?: UiToolName | null;
  overrideModelId?: AppModelId;
  /**
   * The full selection the chat was last held in — a counts object when several
   * models were requested in parallel. `ChatInputProvider` already seeds
   * `selectedModelSelection` from `overrideModelSelection ?? overrideModelId ??
   * defaultModel`, which is the path `MessageEditor` has always used; both props
   * are read ONCE, in `useState` initializers, on each `runtimeKey` mount.
   */
  overrideModelSelection?: SelectedModelValue;
  projectId?: string;
  routeSource?: ChatRouteSource;
  runtimeKey: string;
  store?: CustomChatStoreApi<ChatMessage>;
}) {
  return (
    <ArtifactProvider key={runtimeKey}>
      <CustomStoreProvider<ChatMessage>
        initialMessages={initialMessages}
        key={runtimeKey}
        store={store}
      >
        {isReadonly ? (
          <Chat
            chat={chat}
            id={id}
            isReadonly={isReadonly}
            key={runtimeKey}
            projectId={projectId}
            routeSource={routeSource}
          />
        ) : (
          <ChatInputProvider
            initialTool={initialTool ?? null}
            isProjectContext={!!projectId}
            localStorageEnabled={true}
            overrideModelId={overrideModelId}
            overrideModelSelection={overrideModelSelection}
          >
            <DataStreamHandler key={`stream:${runtimeKey}`} />
            <Chat
              chat={chat}
              id={id}
              isReadonly={isReadonly}
              key={runtimeKey}
              projectId={projectId}
              routeSource={routeSource}
            />
          </ChatInputProvider>
        )}
      </CustomStoreProvider>
    </ArtifactProvider>
  );
});
