"use client";
import type { UseChatHelpers } from "@ai-sdk/react";
import { memo } from "react";
import { CloneChatButton } from "@/components/clone-chat-button";
import { GateVerdictCard } from "@/components/phase/gate-verdict-card";
import type { ChatMessage } from "@/lib/ai/types";
import { useLastMessageId } from "@/lib/stores/hooks-base";
import { cn } from "@/lib/utils";
import { Messages } from "./messages";
import { MultimodalInput } from "./multimodal-input";

interface MessagesPaneProps {
  chatId: string;
  className?: string;
  /** False while this pane is mounted-but-hidden. See MultimodalInput. */
  isActive: boolean;
  isReadonly: boolean;
  /** Set only for a project chat. Drives the gate verdict card. */
  projectId?: string;
  status: UseChatHelpers<ChatMessage>["status"];
}

function PureMessagesPane({
  chatId,
  status,
  isReadonly,
  className,
  isActive,
  projectId,
}: MessagesPaneProps) {
  const parentMessageId = useLastMessageId();

  return (
    <div
      className={cn("flex h-full min-h-0 w-full flex-1 flex-col", className)}
    >
      <Messages className="h-full min-h-0 flex-1" isReadonly={isReadonly} />

      {/*
        THE GATE'S ANSWER, at the foot of the transcript and above the composer.
        Not inside the message list: the verdict is written in `after()`, long
        after the message it judged has flushed, and it is current phase state
        rather than conversation history. This is where a founder is already
        looking when they finish reading a reply.

        Hidden on a read-only clone: a shared transcript is someone else's
        project, and its gate state is not the viewer's to act on.

        NOT `shrink-0`, and a flex column. The card is compact until opened and
        its open body scrolls inside a viewport-relative cap, but on a viewport
        too short even for that (a landscape phone) the card, not the composer,
        is what has to give: this slot and everything inside it may shrink, so
        the composer below keeps its full height. `GateVerdictCard` explains the
        rest.
      */}
      {projectId && !isReadonly ? (
        <div className="flex min-h-0 w-full flex-col @[500px]:px-4 px-2">
          <GateVerdictCard projectId={projectId} />
        </div>
      ) : null}

      <div className="relative @[500px]:bottom-4 z-10 w-full shrink-0">
        {isReadonly ? (
          <CloneChatButton chatId={chatId} className="w-full" />
        ) : (
          <div className="mx-auto w-full p-2 @[500px]:px-4 @[500px]:pb-4 md:max-w-3xl @[500px]:md:pb-6">
            <MultimodalInput
              chatId={chatId}
              isActive={isActive}
              parentMessageId={parentMessageId}
              status={status}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export const MessagesPane = memo(PureMessagesPane);
