import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useRef,
} from "react";
import type { ChatRuntimeId } from "@/lib/chat-runtime-id";
import {
  createMainChatRuntimeId,
  parseChatRuntimeId,
} from "@/lib/chat-runtime-id";
import type { CreateRuntimeInput, Runtime } from "@/lib/runtime-registry";
import { generateUUID } from "@/lib/utils";
import type { ChatMessage, UiToolName } from "./ai/types";
import {
  type CustomChatStoreApi,
  createCustomChatStore,
} from "./stores/custom-store-provider";

export interface AppRuntimeData {
  bootstrap: boolean;
  chatId: string;
  initialMessages?: ChatMessage[];
  initialTool?: UiToolName | null;
  store: CustomChatStoreApi<ChatMessage>;
  threadId: string;
}

export type AppRuntime = Runtime<AppRuntimeData>;
export type CreateAppRuntimeInput = CreateRuntimeInput<AppRuntimeData>;

export interface ProvisionalAppRuntimeIdentity {
  chatId: string;
  runtimeId: ChatRuntimeId;
}

const ProvisionalAppRuntimeIdentityContext =
  createContext<ProvisionalAppRuntimeIdentity | null>(null);

export function ProvisionalAppRuntimeIdentityProvider({
  children,
  identity,
}: {
  children: ReactNode;
  identity: ProvisionalAppRuntimeIdentity | null;
}) {
  return createElement(
    ProvisionalAppRuntimeIdentityContext.Provider,
    { value: identity },
    children
  );
}

export function useCurrentProvisionalAppRuntimeIdentity() {
  return useContext(ProvisionalAppRuntimeIdentityContext);
}

export function useProvisionalAppRuntimeIdentity(
  scopeKey: string | null | undefined
): ProvisionalAppRuntimeIdentity | null {
  const identityRef = useRef<{
    identity: ProvisionalAppRuntimeIdentity;
    scopeKey: string;
  } | null>(null);

  if (!scopeKey) {
    identityRef.current = null;
    return null;
  }

  if (identityRef.current?.scopeKey !== scopeKey) {
    const chatId = generateUUID();

    identityRef.current = {
      identity: {
        chatId,
        runtimeId: createMainChatRuntimeId(chatId),
      },
      scopeKey,
    };
  }

  return identityRef.current.identity;
}

export function createAppRuntimeInput({
  bootstrap,
  initialMessages,
  initialTool,
  runtimeId,
}: {
  bootstrap: boolean;
  initialMessages?: ChatMessage[];
  initialTool?: UiToolName | null;
  runtimeId: ChatRuntimeId;
}): CreateAppRuntimeInput {
  const parsed = parseChatRuntimeId(runtimeId);
  if (!parsed) {
    throw new Error(`Invalid chat runtime id: ${runtimeId}`);
  }

  return {
    data: {
      bootstrap,
      chatId: parsed.chatId,
      initialMessages,
      initialTool,
      store: createAppRuntimeStore({ bootstrap, initialMessages }),
      threadId: parsed.threadId,
    },
    runtimeId,
  };
}

function createAppRuntimeStore({
  bootstrap,
  initialMessages,
}: {
  bootstrap: boolean;
  initialMessages?: ChatMessage[];
}) {
  return createCustomChatStore<ChatMessage>(initialMessages ?? [], {
    initialIsChatPersisted: bootstrap,
  });
}

export function getAppRuntimeStore(runtime: AppRuntime) {
  return runtime.data.store;
}
