"use client";
import { type Dispatch, type SetStateAction, useCallback } from "react";
import { usableStoredModel } from "@/lib/ai/chat-seed-model";
import type { ChatMessage } from "@/lib/ai/types";
import { useChatStatus } from "@/lib/stores/base";
import {
  getAttachmentsFromMessage,
  getTextContentFromMessage,
} from "@/lib/utils";
import { ChatInputProvider } from "@/providers/chat-input-provider";
import { useChatModels } from "@/providers/chat-models-provider";
import { useDefaultModel } from "@/providers/default-model-provider";
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

  // The message's own model choice, through the one stored-model check
  // (`usableStoredModel`): a model the catalog no longer serves would make the
  // edited message 404, so it falls back to the current default.
  const { getModelById } = useChatModels();
  const defaultModel = useDefaultModel();
  const storedModel = usableStoredModel({
    candidates: [props.message.metadata?.selectedModel],
    isKnownModel: (modelId) => Boolean(getModelById(modelId)),
    fallbackModelId: defaultModel,
  });
  const { parentMessageId: _parentMessageId, ...rest } = props;
  return (
    <ChatInputProvider
      initialAttachments={initialAttachments}
      initialInput={initialInput}
      initialTool={props.message.metadata?.selectedTool}
      key={`edit-${props.message.id}`}
      localStorageEnabled={false}
      overrideModelId={storedModel.modelId}
      overrideModelSelection={storedModel.selection}
    >
      <MessageEditorContent
        {...rest}
        parentMessageId={props.message.metadata?.parentMessageId}
      />
    </ChatInputProvider>
  );
}
