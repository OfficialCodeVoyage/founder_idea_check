"use client";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useMemo,
} from "react";
import { editorModelOverrides } from "@/lib/ai/chat-seed-model";
import type { ChatMessage } from "@/lib/ai/types";
import { useChatStatus } from "@/lib/stores/base";
import {
  getAttachmentsFromMessage,
  getTextContentFromMessage,
} from "@/lib/utils";
import { ChatInputProvider } from "@/providers/chat-input-provider";
import { useUsableStoredModel } from "@/providers/use-usable-stored-model";
import { MultimodalInput } from "./multimodal-input";

export interface MessageEditorProps {
  chatId: string;
  message: ChatMessage;
  parentMessageId: string | null;
  setMode: Dispatch<SetStateAction<"view" | "edit">>;
}

function MessageEditorContent({
  chatId,
  setMode,
  parentMessageId,
}: MessageEditorProps & { onModelChange?: (modelId: string) => void }) {
  const status = useChatStatus();

  const handleOnSendMessage = useCallback(
    (_: ChatMessage) => {
      setMode("view");
    },
    [setMode]
  );

  return (
    <div className="w-full">
      <MultimodalInput
        chatId={chatId}
        isEditMode={true}
        onSendMessage={handleOnSendMessage}
        parentMessageId={parentMessageId}
        status={status}
      />
    </div>
  );
}

export function MessageEditor(
  props: MessageEditorProps & { onModelChange?: (modelId: string) => void }
) {
  // Get the initial input value from the message content
  const initialInput = getTextContentFromMessage(props.message);
  const initialAttachments = getAttachmentsFromMessage(props.message);

  // The message's own model choice, through the one stored-model check: a
  // model the catalog no longer serves would make the edited message 404, so
  // the composer's current choice stands in. A message that named no model
  // gets no override, as before.
  const usableModel = useUsableStoredModel();
  const selectedModel = props.message.metadata?.selectedModel;
  const modelOverrides = useMemo(
    () => editorModelOverrides(usableModel([selectedModel])),
    [usableModel, selectedModel]
  );
  const { parentMessageId: _parentMessageId, ...rest } = props;
  return (
    <ChatInputProvider
      initialAttachments={initialAttachments}
      initialInput={initialInput}
      initialTool={props.message.metadata?.selectedTool}
      key={`edit-${props.message.id}`}
      localStorageEnabled={false}
      overrideModelId={modelOverrides.overrideModelId}
      overrideModelSelection={modelOverrides.overrideModelSelection}
    >
      <MessageEditorContent
        {...rest}
        parentMessageId={props.message.metadata?.parentMessageId}
      />
    </ChatInputProvider>
  );
}
