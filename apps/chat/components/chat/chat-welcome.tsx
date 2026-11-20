"use client";

import type { UseChatHelpers } from "@ai-sdk/react";
import { memo, useState } from "react";
import { MultimodalInput } from "@/components/multimodal-input";
import { Button } from "@/components/ui/button";
import type { ChatMessage } from "@/lib/ai/types";
import { useLastMessageId } from "@/lib/stores/hooks-base";
import { cn } from "@/lib/utils";
import { IdeaStart } from "./idea-start";

/**
 * THE HOME SCREEN. It opens on the idea test, because a home-screen chat has no
 * project, so no phases and no gate: sending an idea from here creates a
 * project and opens its first chat (`./use-start-idea-test.ts`). A plain chat
 * stays one click away for a question that is not an idea, with the composer
 * it always had.
 *
 * Only `/` renders this. A project with no messages yet renders `ProjectHome`
 * (`components/chat/chat-content.tsx`), which is untouched.
 */
function PureChatWelcome({
  chatId,
  status,
  className,
  isActive,
}: {
  chatId: string;
  status: UseChatHelpers<ChatMessage>["status"];
  className?: string;
  /** False while this pane is mounted-but-hidden. See MultimodalInput. */
  isActive: boolean;
}) {
  const parentMessageId = useLastMessageId();
  const [mode, setMode] = useState<"idea" | "chat">("idea");

  return (
    // Scrolls, and centres with auto margins rather than `justify-*`: a stack
    // taller than a phone screen would otherwise overflow upward, out of reach.
    <div
      className={cn("flex min-h-0 flex-1 flex-col overflow-y-auto", className)}
    >
      <div className="mx-auto mt-auto w-full p-2 @[500px]:px-4 @[500px]:pb-6 pb-4 md:my-auto md:max-w-3xl">
        {mode === "idea" ? (
          <IdeaStart chatId={chatId} onOpenPlainChat={() => setMode("chat")} />
        ) : (
          <>
            <div className="mb-4 text-center md:mb-6">
              <h1 className="font-normal text-2xl text-foreground sm:text-3xl">
                Ask a quick question
              </h1>
              <p className="mt-2 text-muted-foreground text-sm">
                A plain chat has no phases and no gates.
              </p>
            </div>
            <MultimodalInput
              autoFocus
              chatId={chatId}
              isActive={isActive}
              parentMessageId={parentMessageId}
              status={status}
            />
            <div className="mt-4 text-center">
              <Button
                className="h-auto p-0"
                onClick={() => setMode("idea")}
                type="button"
                variant="link"
              >
                Test an idea instead
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export const ChatWelcome = memo(PureChatWelcome);
