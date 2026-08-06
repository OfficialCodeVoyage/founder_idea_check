"use client";

import { ChatHeader } from "@/components/chat-header";
import type { ChatRouteSource } from "@/lib/chat-route";
import { useMessageIds } from "@/lib/stores/hooks-base";
import type { UIChat } from "@/lib/types/ui-chat";
import { useSession } from "@/providers/session-provider";
import { ChatContent } from "./chat-content";

export function MainChatPanel({
  chat,
  chatId,
  projectId,
  isReadonly,
  className,
  routeSource,
}: {
  chat?: UIChat | null;
  chatId: string;
  projectId?: string;
  isReadonly: boolean;
  className?: string;
  routeSource: ChatRouteSource;
}) {
  const { data: session } = useSession();
  const messageIds = useMessageIds() as string[];
  const hasMessages = messageIds.length > 0;

  return (
    <div className={className}>
      <ChatHeader
        chat={chat}
        chatId={chatId}
        className={"h-(--header-height)"}
        hasMessages={hasMessages}
        isReadonly={isReadonly}
        projectId={projectId}
        routeSource={routeSource}
        user={session?.user}
      />

      <ChatContent
        chatId={chatId}
        className="h-[calc(100dvh_-_var(--header-height))]"
        isReadonly={isReadonly}
        projectId={projectId}
      />
    </div>
  );
}
