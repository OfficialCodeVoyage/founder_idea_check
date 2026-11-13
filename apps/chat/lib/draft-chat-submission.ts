import type { AppModelId } from "@/lib/ai/app-model-id";
import type {
  Attachment,
  ChatMessage,
  SelectedModelValue,
  UiToolName,
} from "@/lib/ai/types";
import { expandSelectedModelValue } from "@/lib/ai/types";
import { generateUUID } from "@/lib/utils";

export interface ParallelRequestSpec {
  assistantMessageId: string;
  createdAt: Date;
  isPrimary: boolean;
  modelId: AppModelId;
  parallelGroupId: string | null;
  parallelIndex: number;
}

export interface DraftChatSubmission {
  message: ChatMessage;
  requestSpecs: ParallelRequestSpec[];
}

/**
 * The model selection a submission is built from: the whole multi-model
 * selection when it names more than one request, else the single model. One
 * rule for the composer and for the gate card's "Plan how to find out", so a
 * founder who picked several models gets the same fan-out from either.
 */
export function normalizeSelectedModel({
  selectedModelId,
  selectedModelSelection,
}: {
  selectedModelId: AppModelId;
  selectedModelSelection: SelectedModelValue;
}): SelectedModelValue {
  return expandSelectedModelValue(selectedModelSelection).length > 1
    ? selectedModelSelection
    : selectedModelId;
}

export function buildDraftChatSubmission({
  attachments,
  input,
  normalizedSelectedModel,
  parallelResponsesEnabled,
  parentMessageId,
  selectedTool,
  targetCriterionId,
}: {
  attachments: Attachment[];
  input: string;
  normalizedSelectedModel: SelectedModelValue;
  parallelResponsesEnabled: boolean;
  parentMessageId: string | null;
  selectedTool: UiToolName | null;
  /** The exit criterion this message answers; see `MessageMetadata`. */
  targetCriterionId?: string | null;
}): DraftChatSubmission {
  const requestedModelIds = expandSelectedModelValue(normalizedSelectedModel);
  const primaryModelId = requestedModelIds[0];

  if (!primaryModelId) {
    throw new Error(
      "Cannot build a draft chat submission without a selected model"
    );
  }

  const isParallelRequest =
    parallelResponsesEnabled && requestedModelIds.length > 1;
  const parallelGroupId = isParallelRequest ? generateUUID() : null;
  const requestSpecs = isParallelRequest
    ? requestedModelIds.map(
        (modelId, parallelIndex): ParallelRequestSpec => ({
          assistantMessageId: generateUUID(),
          createdAt: new Date(Date.now() + parallelIndex),
          isPrimary: parallelIndex === 0,
          modelId,
          parallelGroupId,
          parallelIndex,
        })
      )
    : [
        {
          assistantMessageId: generateUUID(),
          createdAt: new Date(Date.now()),
          isPrimary: true,
          modelId: primaryModelId,
          parallelGroupId: null,
          parallelIndex: 0,
        },
      ];

  return {
    message: {
      id: generateUUID(),
      parts: [
        ...attachments.map((attachment) => ({
          type: "file" as const,
          url: attachment.url,
          name: attachment.name,
          mediaType: attachment.contentType,
        })),
        {
          type: "text",
          text: input,
        },
      ],
      metadata: {
        createdAt: new Date(),
        parentMessageId,
        parallelGroupId,
        parallelIndex: null,
        isPrimaryParallel: null,
        selectedModel: normalizedSelectedModel,
        activeStreamId: null,
        selectedTool: selectedTool || undefined,
        targetCriterionId: targetCriterionId || undefined,
      },
      role: "user",
    },
    requestSpecs,
  };
}
