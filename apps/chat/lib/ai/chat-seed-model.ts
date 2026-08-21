import type { AppModelId } from "@/lib/ai/app-models";
import type { ChatMessage, SelectedModelValue } from "@/lib/ai/types";
import {
  getPrimarySelectedModelId,
  isSelectedModelCounts,
} from "@/lib/ai/types";

/**
 * WHICH MODEL AN EXISTING CHAT WAS BEING HELD IN.
 *
 * THE DEFECT. The model choice was global and only global: `handleModelChange`
 * -> `persistPrimaryModelChange` -> `changeModel` POSTs to /api/chat-model,
 * which sets a `path=/`, one-year `chat-model` cookie; `ChatLayoutDynamic` reads
 * that cookie for EVERY route and feeds `DefaultModelProvider`, and
 * `ChatInputProvider` seeds `selectedModelId` from `overrideModelId ||
 * defaultModel`. `overrideModelId` was only ever set from `?modelId=` on the
 * home route. Nothing read the chat's own history, so opening ANY existing chat
 * — a project chat halfway through the eight-phase workflow included — silently
 * moved its interviewer to whatever model was picked last, anywhere.
 *
 * WHAT THIS IS NOT. It is NOT the gate's judge. `runPostTurnPhasePass` resolves
 * the adjudicator as `getLanguageModel(config.ai.workflows.chat)` and the
 * extractor as `config.ai.workflows.title`, neither of which is threaded from
 * the composer. `getLanguageModel(selectedModelId)` has exactly one caller
 * outside the config-driven ones: `createCoreChatAgent`. So the leak changes the
 * INTERVIEWER that produces the transcript and the per-turn cost — a real
 * correctness bug — and never the model that decides whether a phase passes.
 *
 * PURE. No React, no I/O, no clock.
 */

export type ChatSeedModel = {
  modelId: AppModelId;
  selection: SelectedModelValue;
};

/**
 * `""` IS THE TRAP. `getAllMessagesByChatId` and `getChatMessageWithPartsById`
 * write `"" as ChatMessage["metadata"]["selectedModel"]` when the stored column
 * fails `isSelectedModelValue`, so the empty string is TYPED as an AppModelId
 * and is not one. `MessageEditor` already dodges it with `primaryModelId ||
 * undefined`; the falsy guard below is the same rule, said once and tested.
 */
function readSeed(
  value: SelectedModelValue | null | undefined,
  isKnownModel: (id: string) => boolean
): ChatSeedModel | null {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    return isKnownModel(value) ? { modelId: value, selection: value } : null;
  }

  if (!isSelectedModelCounts(value)) {
    return null;
  }

  const entries = Object.entries(value);
  const kept = entries.filter(([modelId]) => isKnownModel(modelId));
  if (kept.length === 0) {
    return null;
  }

  // IDENTITY MATTERS HERE. `ChatSystem` is memo'd with the default shallow
  // compare, so returning a freshly built object on every call would re-render
  // the whole chat subtree for a value that is only ever read in a `useState`
  // initializer. When nothing had to be dropped, hand back the SAME object the
  // message already holds.
  const selection =
    kept.length === entries.length
      ? value
      : (Object.fromEntries(kept) as SelectedModelValue);
  const modelId = getPrimarySelectedModelId(selection);
  return modelId === null ? null : { modelId, selection };
}

/**
 * The newest usable `metadata.selectedModel` in a thread, or null.
 *
 * USER MESSAGES FIRST, and only then any role. `buildDraftChatSubmission` writes
 * the composer's full `SelectedModelValue` onto the USER row — the counts object
 * when several models were requested in parallel — while an assistant row
 * carries the single model that produced it. Seeding from the newest row of any
 * role would therefore narrow a parallel selection to one model without saying
 * so. The all-roles pass is the fallback for a thread whose user rows carry
 * nothing readable.
 */
export function resolveChatSeedModel({
  messages,
  isKnownModel,
}: {
  messages: readonly ChatMessage[];
  isKnownModel: (id: string) => boolean;
}): ChatSeedModel | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "user") {
      continue;
    }
    const seed = readSeed(message.metadata?.selectedModel, isKnownModel);
    if (seed) {
      return seed;
    }
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const seed = readSeed(messages[i].metadata?.selectedModel, isKnownModel);
    if (seed) {
      return seed;
    }
  }

  return null;
}

/**
 * WHICH MODEL A CHAT OPENS IN, in one place with one precedence order.
 *
 * A PROJECT CHAT DEFAULTS TO THE CONFIGURED INTERVIEWER. Before this, a new
 * project chat opened in whatever model the global `chat-model` cookie last
 * held — so the same eight-phase interview was conducted by a different model
 * depending on what the founder happened to pick in an unrelated chat, and two
 * founders working the same product got different interview quality for reasons
 * neither of them chose. The interview produces the transcript the gate is then
 * asked to judge, so that is not a cosmetic difference.
 *
 * IT IS A DEFAULT, NOT A PIN. The founder can still change the model from the
 * picker, and that choice survives: it is written onto the user row's
 * `metadata.selectedModel`, so `resolveChatSeedModel` finds it on the next
 * mount and returns it from a HIGHER precedence slot than this one. A pin would
 * have meant reassigning the model on every mount, which is the defect this
 * file was created to remove, pointed at a different cause.
 *
 * Precedence, highest first:
 *   1. `?modelId=` deep link — an explicit request in the URL.
 *   2. The chat's own history — what this conversation was actually held in,
 *      including a change the founder made mid-chat.
 *   3. The configured interviewer, for a project chat with no history yet.
 *   4. Nothing, which leaves the global default in charge (plain chats).
 *
 * The configured interviewer is validated like every other id: a config naming
 * a model this gateway does not serve falls through to the global default
 * rather than seeding the composer with something unselectable.
 *
 * PURE. No React, no I/O, no clock.
 */
export function resolveOpeningModelId({
  deepLinkModelId,
  seedModelId,
  projectInterviewerModelId,
  isKnownModel,
}: {
  deepLinkModelId?: AppModelId;
  seedModelId?: AppModelId;
  /**
   * `config.ai.workflows.chat`, and ONLY for a project chat. Undefined for a
   * plain chat — the interviewer default is a project concept, and applying it
   * everywhere would quietly override the picker for ordinary conversations.
   */
  projectInterviewerModelId?: string;
  isKnownModel: (id: string) => boolean;
}): AppModelId | undefined {
  if (deepLinkModelId) {
    return deepLinkModelId;
  }
  if (seedModelId) {
    return seedModelId;
  }
  if (projectInterviewerModelId && isKnownModel(projectInterviewerModelId)) {
    return projectInterviewerModelId as AppModelId;
  }
  return;
}
