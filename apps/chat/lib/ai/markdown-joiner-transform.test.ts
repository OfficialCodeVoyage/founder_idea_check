import type { TextStreamPart, ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import { markdownJoinerTransform } from "./markdown-joiner-transform";

/**
 * The bug these reproduce: the joiner buffers from `[` until a newline, and
 * used to emit whatever was still buffered from the TransformStream's `flush`
 * — which runs after `finish`, by which point ai@6's `processUIMessageStream`
 * has already deleted the text part. The emitted delta had no `id` at all, so
 * the stream threw `Received text-delta for missing text part with ID
 * "undefined"`, the transform rejected, `onFinish` never ran, and therefore
 * `after(runPostTurnPhasePass)` never ran — the gate silently never assessed
 * the turn.
 *
 * Adding an `id` is NOT sufficient and these tests encode that: a delta
 * emitted after `text-end` or `finish-step` is invalid whatever id it carries,
 * because those chunks retire the part. The buffer has to leave while the part
 * is still open, which is why there are three drain sites.
 */

type Chunk = TextStreamPart<ToolSet>;

async function run(input: Chunk[]): Promise<Chunk[]> {
  const stream = new ReadableStream<Chunk>({
    start(controller) {
      for (const chunk of input) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });

  const transform = markdownJoinerTransform<ToolSet>()();
  const out: Chunk[] = [];
  const reader = stream.pipeThrough(transform).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    out.push(value);
  }
  return out;
}

function textStart(id: string): Chunk {
  return { type: "text-start", id } as Chunk;
}
function textDelta(id: string, text: string): Chunk {
  return { type: "text-delta", id, text } as Chunk;
}
function textEnd(id: string): Chunk {
  return { type: "text-end", id } as Chunk;
}

/** Every delta must name a part that is open at the moment it arrives. */
function firstOrphanDelta(chunks: Chunk[]): Chunk | null {
  const open = new Set<string>();
  for (const chunk of chunks) {
    if (chunk.type === "text-start") {
      open.add(chunk.id);
    } else if (chunk.type === "text-end") {
      open.delete(chunk.id);
    } else if (chunk.type === "finish-step") {
      // processUIMessageStream clears activeTextParts here.
      open.clear();
    } else if (chunk.type === "text-delta") {
      const id = (chunk as { id?: string }).id;
      if (id === undefined || !open.has(id)) {
        return chunk;
      }
    }
  }
  return null;
}

function textOf(chunks: Chunk[]): string {
  return chunks
    .filter((c): c is Chunk & { text: string } => c.type === "text-delta")
    .map((c) => c.text)
    .join("");
}

describe("markdownJoinerTransform", () => {
  it("emits no orphan delta when a reply ends mid-buffer", async () => {
    // The exact reported shape: a final paragraph starting with "[" and no
    // trailing newline, so the buffer is still held when the block closes.
    const out = await run([
      textStart("t0"),
      textDelta("t0", "Here is the read.\n\n"),
      textDelta("t0", "[Data] partial"),
      textEnd("t0"),
      { type: "finish-step" } as Chunk,
      { type: "finish" } as Chunk,
    ]);

    expect(firstOrphanDelta(out)).toBeNull();
  });

  it("does not lose the buffered tail", async () => {
    const out = await run([
      textStart("t0"),
      textDelta("t0", "Here is the read.\n\n"),
      textDelta("t0", "[Data] partial"),
      textEnd("t0"),
      { type: "finish-step" } as Chunk,
      { type: "finish" } as Chunk,
    ]);

    // Dropping it silently would mean the founder never sees the last sentence.
    expect(textOf(out)).toBe("Here is the read.\n\n[Data] partial");
  });

  it("drains before text-end, not after it", async () => {
    const out = await run([
      textStart("t0"),
      textDelta("t0", "[Data] held"),
      textEnd("t0"),
      { type: "finish" } as Chunk,
    ]);

    const deltaIdx = out.findIndex(
      (c) =>
        c.type === "text-delta" && (c as { text: string }).text.includes("held")
    );
    const endIdx = out.findIndex((c) => c.type === "text-end");
    expect(deltaIdx).toBeGreaterThanOrEqual(0);
    expect(deltaIdx).toBeLessThan(endIdx);
  });

  it("does not leak a buffer across a step boundary", async () => {
    // A step that ends with no text-end. Without the finish-step drain the
    // held text reappears inside the NEXT step's part.
    const out = await run([
      textStart("a"),
      textDelta("a", "step one [Data"),
      { type: "finish-step" } as Chunk,
      textStart("b"),
      textDelta("b", "step two.\n"),
      textEnd("b"),
      { type: "finish" } as Chunk,
    ]);

    expect(firstOrphanDelta(out)).toBeNull();
    const bText = out
      .filter(
        (c): c is Chunk & { id: string; text: string } =>
          c.type === "text-delta" && (c as { id?: string }).id === "b"
      )
      .map((c) => c.text)
      .join("");
    expect(bText).toBe("step two.\n");
    expect(bText).not.toContain("[Data");
  });

  it("recovers the buffer on the abort path, which has no text-end", async () => {
    // streamText enqueues `abort` and closes with neither text-end nor
    // finish-step, so only the flush drain can recover this.
    const out = await run([
      textStart("t0"),
      textDelta("t0", "Here is the read.\n\n"),
      textDelta("t0", "[Data] partial"),
      { type: "abort" } as Chunk,
    ]);

    expect(textOf(out)).toContain("[Data] partial");
    expect(firstOrphanDelta(out)).toBeNull();
  });

  it("attributes a fragment to its own block when deltas interleave", async () => {
    const out = await run([
      textStart("a"),
      textDelta("a", "alpha [x"),
      textStart("b"),
      textDelta("b", "beta\n"),
      textEnd("b"),
      textEnd("a"),
      { type: "finish" } as Chunk,
    ]);

    expect(firstOrphanDelta(out)).toBeNull();
  });

  it("still joins a split markdown link, and emits no empty deltas", async () => {
    // Regression control: the behaviour the buffering exists for.
    const out = await run([
      textStart("t0"),
      textDelta("t0", "see ["),
      textDelta("t0", "docs"),
      textDelta("t0", "](https://x.test)"),
      textDelta("t0", " now\n"),
      textEnd("t0"),
      { type: "finish" } as Chunk,
    ]);

    expect(textOf(out)).toBe("see [docs](https://x.test) now\n");
    const empty = out.filter(
      (c) => c.type === "text-delta" && (c as { text: string }).text === ""
    );
    expect(empty).toHaveLength(0);
  });

  it("passes non-text chunks through untouched", async () => {
    const out = await run([
      { type: "start" } as Chunk,
      { type: "start-step" } as Chunk,
      textStart("t0"),
      textDelta("t0", "hi\n"),
      textEnd("t0"),
      { type: "finish-step" } as Chunk,
      { type: "finish" } as Chunk,
    ]);

    expect(out.map((c) => c.type)).toEqual([
      "start",
      "start-step",
      "text-start",
      "text-delta",
      "text-end",
      "finish-step",
      "finish",
    ]);
  });
});
