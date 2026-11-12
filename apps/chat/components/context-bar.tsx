"use client";

import { PromptInputHeader } from "@/components/ai-elements/prompt-input";
import { AttachmentList } from "@/components/attachment-list";
import type { Attachment } from "@/lib/ai/types";
import { cn } from "@/lib/utils";

export function ContextBar({
  attachments,
  uploadQueue,
  onRemoveAction,
  className,
  chatId,
}: {
  attachments: Attachment[];
  uploadQueue: string[];
  onRemoveAction: (attachment: Attachment) => void;
  className?: string;
  /** See `AttachmentList`: an edited message's older files load through it. */
  chatId?: string;
}) {
  const hasBarContent = attachments.length > 0 || uploadQueue.length > 0;

  if (!hasBarContent) {
    return null;
  }

  return (
    <PromptInputHeader className={cn("w-full border-b bg-muted", className)}>
      {(attachments.length > 0 || uploadQueue.length > 0) && (
        <AttachmentList
          attachments={attachments}
          chatId={chatId}
          onRemoveAction={onRemoveAction}
          testId="attachments-preview"
          uploadQueue={uploadQueue}
        />
      )}
    </PromptInputHeader>
  );
}
