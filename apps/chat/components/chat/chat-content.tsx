"use client";

import { memo } from "react";
import { MessagesPane } from "@/components/messages-pane";
import { ProjectHome } from "@/components/project-home";
import { useChatStatus } from "@/lib/stores/base";
import { useMessageIds } from "@/lib/stores/hooks-base";
import { cn } from "@/lib/utils";
import { ChatWelcome } from "./chat-welcome";

function PureChatContent({
  chatId,
  className,
  projectId,
  isReadonly,
}: {
  chatId: string;
  className?: string;
  projectId?: string;
  isReadonly: boolean;
}) {
  const status = useChatStatus();
  const messageIds = useMessageIds() as string[];
  const hasMessages = messageIds.length > 0;

  // Project context: switch between ProjectHome and MessagesPane
  if (projectId) {
    return hasMessages ? (
      <MessagesPane
        chatId={chatId}
        className={cn("bg-background", className)}
        isActive
        isReadonly={isReadonly}
        projectId={projectId}
        status={status}
      />
    ) : (
      <ProjectHome
        chatId={chatId}
        className={cn("h-full", className)}
        projectId={projectId}
        status={status}
      />
    );
  }

  // Non-project: keep both mounted, toggle visibility with CSS.
  //
  // `isActive` is computed from the SAME expression as the `hidden` class, on
  // the same line, so the two cannot drift. Both composers stay mounted (the
  // mount strategy is inherited from upstream and is deliberately not changed
  // here), but only one of them claims the testids and the shared `editorRef`.
  return (
    <>
      <ChatWelcome
        chatId={chatId}
        className={cn(className, hasMessages && "hidden")}
        isActive={!hasMessages}
        status={status}
      />
      <MessagesPane
        chatId={chatId}
        className={cn("bg-background", className, !hasMessages && "hidden")}
        isActive={hasMessages}
        isReadonly={isReadonly}
        status={status}
      />
    </>
  );
}

export const ChatContent = memo(PureChatContent);
