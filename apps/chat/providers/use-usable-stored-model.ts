"use client";

import { useCallback } from "react";
import {
  type UsableStoredModel,
  usableStoredModel,
} from "@/lib/ai/chat-seed-model";
import type { SelectedModelValue } from "@/lib/ai/types";
import { useStableChatInput } from "@/providers/chat-input-provider";
import { useChatModels } from "@/providers/chat-models-provider";

/**
 * The ONE place a stored model choice is checked before a client path sends it
 * again (Retry, the message editor, a parallel response card): against the
 * catalog, with the composer's current primary model standing in for a model
 * the catalog no longer serves (`lib/ai/chat-seed-model.ts::usableStoredModel`).
 * Read from the composer's stable context, so a caller does not re-render as
 * the founder types; the returned function changes only when the catalog or
 * the composer's model does.
 */
export function useUsableStoredModel(): (
  candidates: readonly (SelectedModelValue | null | undefined)[]
) => UsableStoredModel | null {
  const { getModelById } = useChatModels();
  const { selectedModelId } = useStableChatInput();
  return useCallback(
    (candidates) =>
      usableStoredModel({
        candidates,
        isKnownModel: (modelId) => Boolean(getModelById(modelId)),
        composerModelId: selectedModelId,
      }),
    [getModelById, selectedModelId]
  );
}
