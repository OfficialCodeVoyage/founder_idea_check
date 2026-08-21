"use client";

import { ChatHeader } from "@/components/chat-header";
import { PhaseGateProvider } from "@/components/phase/phase-gate-provider";
import { PhaseRail } from "@/components/phase-rail";
import type { ChatRouteSource } from "@/lib/chat-route";
import { useChatStatus } from "@/lib/stores/base";
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
  // The rail keys off the STREAM, not the message count: the gate runs after
  // the answer finishes, so the message count changes far too early.
  const status = useChatStatus();

  // The rail is h-9 (2.25rem). ChatContent's height is hardcoded against
  // --header-height, so the rail's height has to be subtracted explicitly
  // here — there is no flex parent to absorb it.
  const contentHeight = projectId
    ? "h-[calc(100dvh_-_var(--header-height)_-_2.25rem)]"
    : "h-[calc(100dvh_-_var(--header-height))]";

  const header = (
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
  );
  const content = (
    <ChatContent
      chatId={chatId}
      className={contentHeight}
      isReadonly={isReadonly}
      projectId={projectId}
    />
  );

  if (!projectId) {
    return (
      <div className={className}>
        {header}
        {content}
      </div>
    );
  }

  // The rail and the verdict card BOTH describe the gate, so they share one
  // query and one wait through the provider rather than polling independently.
  // It wraps the content too, because the card renders at the foot of the
  // transcript inside MessagesPane.
  return (
    <div className={className}>
      <PhaseGateProvider
        isStreaming={status === "streaming" || status === "submitted"}
        projectId={projectId}
      >
        {header}
        <PhaseRail className="h-9" projectId={projectId} />
        {content}
      </PhaseGateProvider>
    </div>
  );
}
