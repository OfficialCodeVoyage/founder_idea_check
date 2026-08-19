"use client";

import { ChatHeader } from "@/components/chat-header";
import { PhaseRail } from "@/components/phase-rail";
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

  // The rail is h-9 (2.25rem). ChatContent's height is hardcoded against
  // --header-height, so the rail's height has to be subtracted explicitly
  // here — there is no flex parent to absorb it.
  const contentHeight = projectId
    ? "h-[calc(100dvh_-_var(--header-height)_-_2.25rem)]"
    : "h-[calc(100dvh_-_var(--header-height))]";

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

      {projectId ? (
        <PhaseRail
          className="h-9"
          projectId={projectId}
          refreshKey={messageIds.length}
        />
      ) : null}

      <ChatContent
        chatId={chatId}
        className={contentHeight}
        isReadonly={isReadonly}
        projectId={projectId}
      />
    </div>
  );
}
