import type { FinishReason, InferUIMessageChunk } from "ai";
import { REFUSED_REPLY_NOTICE } from "@/lib/ai/stream-errors";
import type { ChatMessage } from "@/lib/ai/types";

type ChatChunk = InferUIMessageChunk<ChatMessage>;

/**
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
export function refusedFinishMetadata(
  finishReason: FinishReason
): { refused: true } | Record<string, never> {
  return finishReason === "content-filter" ? { refused: true } : {};
}

/**
 * The transform the chat model's UI stream goes through: on a `finish` chunk
 * whose metadata says `refused`, it calls `onRefused` and writes the notice
 * right before that chunk. `checked` resolves once the finish chunk has gone
 * past (or the stream ended without one), so a caller can read what
 * `onRefused` set without racing the stream.
 */
export function insertRefusalNotice({
  noticeId,
  onRefused,
}: {
  noticeId: string;
  onRefused: () => void;
}): { stream: TransformStream<ChatChunk, ChatChunk>; checked: Promise<void> } {
  let markChecked: () => void = () => undefined;
  const checked = new Promise<void>((resolve) => {
    markChecked = resolve;
  });
  const stream = new TransformStream<ChatChunk, ChatChunk>({
    transform(chunk, controller) {
      if (chunk.type === "finish") {
        if (chunk.messageMetadata?.refused === true) {
          onRefused();
          controller.enqueue({ type: "text-start", id: noticeId });
          controller.enqueue({
            type: "text-delta",
            id: noticeId,
            delta: REFUSED_REPLY_NOTICE,
          });
          controller.enqueue({ type: "text-end", id: noticeId });
        }
        controller.enqueue(chunk);
        markChecked();
        return;
      }
      controller.enqueue(chunk);
    },
    flush() {
      markChecked();
    },
  });
  return { stream, checked };
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
