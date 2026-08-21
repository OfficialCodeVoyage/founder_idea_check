import type { TextStreamPart, ToolSet } from "ai";

// Regex patterns for markdown matching
const LINK_PATTERN = /^\[.*?\]\(.*?\)$/;
const BOLD_PATTERN = /^\*\*.*?\*\*$/;
const WHITESPACE_PATTERN = /\s/;

class MarkdownJoiner {
  private buffer = "";
  private isBuffering = false;

  processText(text: string): string {
    let output = "";

    for (const char of text) {
      if (this.isBuffering) {
        this.buffer += char;

        // Check for complete markdown elements or false positives
        if (this.isCompleteLink() || this.isCompleteBold()) {
          // Complete markdown element - flush buffer as is
          output += this.buffer;
          this.clearBuffer();
        } else if (this.isFalsePositive(char)) {
          // False positive - flush buffer as raw text
          output += this.buffer;
          this.clearBuffer();
        }
      } else if (char === "[" || char === "*") {
        this.buffer = char;
        this.isBuffering = true;
      } else {
        // Pass through character directly
        output += char;
      }
    }

    return output;
  }

  private isCompleteLink(): boolean {
    // Match [text](url) pattern
    return LINK_PATTERN.test(this.buffer);
  }

  private isCompleteBold(): boolean {
    // Match **text** pattern
    return BOLD_PATTERN.test(this.buffer);
  }

  private isFalsePositive(char: string): boolean {
    // For links: if we see [ followed by something other than valid link syntax
    if (this.buffer.startsWith("[")) {
      // If we hit a newline or another [ without completing the link, it's false positive
      return char === "\n" || (char === "[" && this.buffer.length > 1);
    }

    // For bold: if we see * or ** followed by whitespace or newline
    if (this.buffer.startsWith("*")) {
      // Single * followed by whitespace is likely a list item
      if (this.buffer.length === 1 && WHITESPACE_PATTERN.test(char)) {
        return true;
      }
      // If we hit newline without completing bold, it's false positive
      return char === "\n";
    }

    return false;
  }

  private clearBuffer(): void {
    this.buffer = "";
    this.isBuffering = false;
  }

  flush(): string {
    const remaining = this.buffer;
    this.clearBuffer();
    return remaining;
  }
}

/**
 * Fallback id for the one path where the buffer outlives every text block.
 * Unreachable in normal operation; see `drain`.
 */
const ORPHAN_FLUSH_ID = "markdown-joiner-flush";

/**
 * Buffers `[`/`*` so a markdown link or bold span is never split across two
 * deltas, and emits what it held BEFORE the text part it belongs to closes.
 *
 * WHY THE TIMING IS THE WHOLE FIX. This transform sits on the entire
 * `TextStreamPart` stream, so `text-start`, `text-end`, `finish-step` and
 * `finish` all pass through it, and a TransformStream's `flush` runs only after
 * the source closes — after `finish`. Emitting the leftover buffer from `flush`
 * as a bare `{ type: "text-delta", text }` therefore produced
 * `AI_UIMessageStreamError: Received text-delta for missing text part with ID
 * "undefined"`, which rejected the transform, skipped `onFinish` entirely, and
 * so skipped `after(runPostTurnPhasePass)` — the gate never ran and the phase
 * rail said NOT ASSESSED, indistinguishable from "not yet".
 *
 * ADDING THE MISSING `id` DOES NOT FIX IT. In ai@6's
 * `processUIMessageStream`, `text-end` deletes the part from `activeTextParts`
 * and `finish-step` clears the map, so a delta arriving at flush time is
 * invalid whatever id it carries — it merely changes the error to ID "0". The
 * buffer has to be drained while the part is still open.
 *
 * ALL THREE DRAIN SITES ARE LOAD-BEARING and each covers a path the others do
 * not. Deleting any one returns the bug on a different trigger:
 *   - `text-end`    the normal end of a text block. This is the reported case.
 *   - `finish-step` a step that ends with no `text-end` (multi-step with
 *                   tools); without it the buffer leaks into the NEXT step's
 *                   delta and text crosses a part boundary.
 *   - `flush`       the ABORT path only. `streamText` enqueues `{type:"abort"}`
 *                   and closes with no `text-end` and no `finish-step`, so this
 *                   is the only site that recovers the buffer. It is valid
 *                   there precisely because `processUIMessageStream` has no
 *                   `abort` case, so the part is still live.
 *
 * The trigger in this product is not exotic: the assistant persona mandates
 * `[Data]` / `[Yellow flag]` paragraph prefixes, and `isFalsePositive` releases
 * a `[`-buffer only on a newline or a second `[`, so any reply whose final
 * paragraph starts with `[` and lacks a trailing newline hit it.
 */
type Controller<TOOLS extends ToolSet> = TransformStreamDefaultController<
  TextStreamPart<TOOLS>
>;

export const markdownJoinerTransform =
  <TOOLS extends ToolSet>() =>
  () => {
    const joiner = new MarkdownJoiner();
    /** The text part currently open downstream, or null between blocks. */
    let openTextId: string | null = null;

    function drain(
      controller: TransformStreamDefaultController<TextStreamPart<TOOLS>>
    ) {
      const remaining = joiner.flush();
      if (!remaining) {
        return;
      }
      if (openTextId !== null) {
        controller.enqueue({
          type: "text-delta",
          id: openTextId,
          text: remaining,
        });
        return;
      }
      // No part is open, so the fragment needs one of its own rather than
      // being dropped. Losing buffered text silently would be worse than an
      // extra part: the founder would simply never see the last sentence.
      controller.enqueue({ type: "text-start", id: ORPHAN_FLUSH_ID });
      controller.enqueue({
        type: "text-delta",
        id: ORPHAN_FLUSH_ID,
        text: remaining,
      });
      controller.enqueue({ type: "text-end", id: ORPHAN_FLUSH_ID });
    }

    /**
     * A delta for a different part means the previous one never closed; drain
     * first so the buffer is attributed to the block it came from.
     */
    function openPart(id: string, controller: Controller<TOOLS>) {
      if (openTextId !== null && id !== openTextId) {
        drain(controller);
      }
      openTextId = id;
    }

    /**
     * Only clear the id this chunk actually closes — clearing it
     * unconditionally would orphan a still-open overlapping block.
     */
    function closePart(id: string, controller: Controller<TOOLS>) {
      if (id === openTextId) {
        drain(controller);
        openTextId = null;
      }
    }

    return new TransformStream<TextStreamPart<TOOLS>, TextStreamPart<TOOLS>>({
      transform(chunk, controller) {
        switch (chunk.type) {
          case "text-start":
            openTextId = chunk.id;
            controller.enqueue(chunk);
            break;
          case "text-delta": {
            openPart(chunk.id, controller);
            const processedText = joiner.processText(chunk.text);
            // The guard stays: while buffering most chunks produce no output,
            // and zero-length deltas would change the happy-path wire format.
            if (processedText) {
              controller.enqueue({ ...chunk, text: processedText });
            }
            break;
          }
          case "text-end":
            closePart(chunk.id, controller);
            controller.enqueue(chunk);
            break;
          case "finish-step":
            drain(controller);
            openTextId = null;
            controller.enqueue(chunk);
            break;
          default:
            controller.enqueue(chunk);
            break;
        }
      },
      flush(controller) {
        drain(controller);
        openTextId = null;
      },
    });
  };
