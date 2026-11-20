import type { FinishReason, InferUIMessageChunk } from "ai";
import { REFUSED_REPLY_NOTICE } from "@/lib/ai/stream-errors";
import type { ChatMessage } from "@/lib/ai/types";

type ChatChunk = InferUIMessageChunk<ChatMessage>;

/*
 * A DECLINED REPLY, RECOGNISED ONCE: from the finish part of the chat model's
 * own stream. Claude's `refusal` stop reason arrives as `content-filter` with
 * an empty (or cut-off) reply and no error. That one event drives all three
 * effects, so they cannot disagree:
 *
 *  - the `finish` metadata says `refused` (`refusedFinishMetadata`, from the
 *    finish part's own finish reason);
 *  - the notice is written into the reply right before that finish chunk
 *    (`insertRefusalNotice`), so it is saved with the reply and is still
 *    there after a reload;
 *  - the stored marker is read from the finished reply's own metadata
 *    (`finishedReplyRefused`), never from a separate flag.
 *
 * WHY THE ORDER. The SDK's message state applies chunks in order, and the
 * chat route's onFinish may run from the stream's `cancel` (a processing
 * failure partway through) with whatever the state holds at that moment. The
 * notice comes before the finish chunk that carries the mark, so a reply
 * that holds the mark always holds the notice, and a cancel before them
 * leaves neither. What a declined turn is charged is unchanged.
 */

/**
 * The `finish` chunk's metadata for a call that ended with this finish reason:
 * `{ refused: true }` when it was declined, otherwise nothing.
 */
export function refusedFinishMetadata(
  finishReason: FinishReason
): { refused: true } | Record<string, never> {
  return isDeclined(finishReason) ? { refused: true } : {};
}

/**
 * PURE. Whether a call's finish reason means the model declined to go on
 * (Claude's `refusal` stop reason, `content-filter` in the AI SDK): no error,
 * and an empty or partial result. Every call path that reads a refusal asks
 * here.
 */
export function isDeclined(finishReason: string | undefined): boolean {
  return finishReason === "content-filter";
}

/**
 * A STRUCTURED-OUTPUT CALL THE MODEL DECLINED: the gate judge, the fact
 * extractor, the persona generator, and deep research's clarify and brief
 * steps. Thrown by `lib/phases/model-adapters.ts::generateReportingUsage`,
 * the one wrapper those calls share and the only place that still sees the
 * call's finish reason; every caller asks `isDeclinedCall`.
 *
 * WHY A TYPE OF ITS OWN. The SDK reports such a decline in two shapes, and
 * neither says "declined" on its face: an empty reply leaves `output` unset
 * and reading it throws `NoOutputGeneratedError`, which carries no finish
 * reason at all; a partial reply fails to parse and throws
 * `NoObjectGeneratedError` with `finishReason: "content-filter"`. Both used
 * to reach the callers as "the call failed", so a gate BLOCK, a lost
 * extraction and a failed research run all named a plumbing fault where the
 * model had in fact declined, and the founder was never told that rephrasing
 * could help.
 *
 * Lives here, not beside the wrapper, because the pure seams that catch it
 * (`lib/phases/gate.ts`, `lib/phases/extract.ts`) must not import "ai": this
 * file only takes types from it.
 */
export class DeclinedCallError extends Error {
  /** Which seam's call was declined, e.g. "phase-gate". */
  readonly functionId: string;

  constructor(functionId: string, options?: { cause?: unknown }) {
    super(
      `the model declined to answer (${functionId}, finish reason: content-filter)`,
      options
    );
    this.name = "DeclinedCallError";
    this.functionId = functionId;
  }
}

/** PURE. Whether a structured-output call failed because the model declined. */
export function isDeclinedCall(error: unknown): error is DeclinedCallError {
  return error instanceof DeclinedCallError;
}

/**
 * The transform the chat model's UI stream goes through: on a `finish` chunk
 * whose metadata says `refused`, it writes the notice right before that chunk.
 * Nothing waits on it: what else a declined turn skips is read from the model
 * call itself.
 */
export function insertRefusalNotice(
  noticeId: string
): TransformStream<ChatChunk, ChatChunk> {
  return new TransformStream<ChatChunk, ChatChunk>({
    transform(chunk, controller) {
      if (chunk.type === "finish" && chunk.messageMetadata?.refused === true) {
        controller.enqueue({ type: "text-start", id: noticeId });
        controller.enqueue({
          type: "text-delta",
          id: noticeId,
          delta: REFUSED_REPLY_NOTICE,
        });
        controller.enqueue({ type: "text-end", id: noticeId });
      }
      controller.enqueue(chunk);
    },
  });
}

/**
 * PURE. Whether the finished reply carries the refusal mark, as the chat
 * route's own stream wrote it: `createUIMessageStream` is given no
 * `originalMessages`, so the reply in its onFinish is built only from this
 * request's chunks, never from anything a client sent.
 */
export function finishedReplyRefused(
  messages: readonly ChatMessage[]
): boolean {
  return messages.at(-1)?.metadata?.refused === true;
}
