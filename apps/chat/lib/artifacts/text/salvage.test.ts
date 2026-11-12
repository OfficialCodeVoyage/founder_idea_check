import { describe, expect, it } from "vitest";
import { validateToolPart } from "@/lib/utils/message-part-validators";
import {
  DEAD_INPUT_STREAM_MARKER,
  describeInputStream,
  hasInputStreamEnded,
  isDeadStreamAnnouncement,
  partialDocumentBody,
  partialDocumentTitle,
  salvageTextDocumentInput,
  sweepDeadInputStreams,
} from "./salvage";

/**
 * The real incident, reproduced in shape and size.
 *
 * The incident's `Part` row held 26,731 characters of
 * `tool_input` JSON: a 26,305-character markdown protocol whose last line is a
 * table row that stops mid-sentence, inside the INTENSITY rubric at score 3.
 * `buildTruncatedInputJson` rebuilds a payload with those proportions so the
 * prefix scanner is exercised against the thing that actually happened rather
 * than against a toy `{"a":`.
 */
const REAL_TITLE =
  "Phase 1 Problem Validation: Preregistered Evidence Instrument for Identifying Frequent, Painful, Already-Paid Parent Problems";

const NO_CONTENT_ARRIVED = /before any document content arrived/i;
const NEVER_FINISHED = /never finished/i;
const PARTIAL_AT_START = /^\[PARTIAL/i;
const UNTITLED = /untitled/i;

const REAL_LAST_LINE =
  "| 3 | Clear disruption: approximately 10–20 additional minutes, repeated";

function buildTruncatedContent(): string {
  const head =
    "# Phase 1 Problem Validation\n\n" +
    'Every claim must carry a label such as **MEASURED**, **ESTIMATED**, or "INSUFFICIENT EVIDENCE".\n' +
    "A backslash \\\\ and a tab\tsurvive the round trip.\n\n";
  // Filler shaped like the rubric tables that filled the real document, padded
  // to the same order of magnitude as the 26,305 characters that arrived.
  const rows: string[] = [];
  while (head.length + rows.join("").length < 26_000) {
    rows.push(
      `| ${rows.length % 4} | Routine completed with minor delay; no meaningful trade-off. | Event sequence and approximate duration. |\n`
    );
  }
  return `${head}${rows.join("")}## 7. INTENSITY\n\n${REAL_LAST_LINE}`;
}

function buildTruncatedInputJson(): string {
  const content = buildTruncatedContent();
  // A complete object would end `..."}`. The stream died before either.
  return `{"title":${JSON.stringify(REAL_TITLE)},"content":${JSON.stringify(
    content
  ).slice(0, -1)}`;
}

describe("salvageTextDocumentInput", () => {
  it("salvages the partially parsed object the SDK actually leaves behind", () => {
    const content = buildTruncatedContent();
    const result = salvageTextDocumentInput({ title: REAL_TITLE, content });

    expect(result.salvaged).toBe(true);
    if (!result.salvaged) {
      return;
    }
    expect(result.title).toBe(REAL_TITLE);
    expect(result.content).toBe(content);
    expect(result.contentChars).toBe(content.length);
    expect(result.stoppedAfter).toBe(REAL_LAST_LINE);
    expect(result.recoveredFrom).toBe("partial-object");
  });

  it("salvages a raw JSON prefix that will never parse", () => {
    const raw = buildTruncatedInputJson();
    expect(raw.length).toBeGreaterThan(26_000);
    expect(() => JSON.parse(raw)).toThrow();

    const result = salvageTextDocumentInput(raw);

    expect(result.salvaged).toBe(true);
    if (!result.salvaged) {
      return;
    }
    expect(result.title).toBe(REAL_TITLE);
    expect(result.content).toBe(buildTruncatedContent());
    expect(result.stoppedAfter).toBe(REAL_LAST_LINE);
    expect(result.recoveredFrom).toBe("json-prefix");
  });

  it("decodes escapes and drops a half-arrived escape sequence", () => {
    // The stream died in the middle of a \u escape. Four of the six characters
    // arrived, so the codepoint is unknowable and the only honest thing to do
    // is drop it rather than emit a replacement character.
    const raw = '{"title":"T","content":"one \\"two\\" three \\u26';
    const result = salvageTextDocumentInput(raw);

    expect(result.salvaged).toBe(true);
    if (!result.salvaged) {
      return;
    }
    expect(result.content).toBe('one "two" three ');
  });

  it("drops a dangling backslash rather than failing the whole salvage", () => {
    const result = salvageTextDocumentInput('{"title":"T","content":"a b\\');

    expect(result.salvaged).toBe(true);
    if (!result.salvaged) {
      return;
    }
    expect(result.content).toBe("a b");
  });

  it("parses a prefix that happens to be complete JSON", () => {
    const result = salvageTextDocumentInput('{"title":"T","content":"body"}');

    expect(result.salvaged).toBe(true);
    if (!result.salvaged) {
      return;
    }
    expect(result.recoveredFrom).toBe("json-prefix");
    expect(result.content).toBe("body");
  });

  it("reports a null title rather than inventing one", () => {
    const result = salvageTextDocumentInput({ content: "orphan body" });

    expect(result.salvaged).toBe(true);
    if (!result.salvaged) {
      return;
    }
    expect(result.title).toBeNull();
  });

  it("refuses to salvage when only the title arrived", () => {
    const result = salvageTextDocumentInput({ title: REAL_TITLE });

    expect(result.salvaged).toBe(false);
    if (result.salvaged) {
      return;
    }
    expect(result.why).toMatch(NO_CONTENT_ARRIVED);
  });

  it("refuses to salvage whitespace-only content", () => {
    const result = salvageTextDocumentInput({ title: "T", content: "   \n\n" });
    expect(result.salvaged).toBe(false);
  });

  it("refuses to salvage nothing at all", () => {
    for (const input of [undefined, null, 42, [], ""]) {
      const result = salvageTextDocumentInput(input);
      expect(result.salvaged).toBe(false);
      if (!result.salvaged) {
        expect(result.why.length).toBeGreaterThan(0);
      }
    }
  });

  it("the unsalvageable arm carries no content to read", () => {
    const result = salvageTextDocumentInput(null);
    expect(result).not.toHaveProperty("content");
    expect(result).not.toHaveProperty("title");
    expect(result).not.toHaveProperty("contentChars");
  });
});

describe("describeInputStream", () => {
  const content = buildTruncatedContent();

  it("calls a live input-streaming part alive while the stream runs", () => {
    const verdict = describeInputStream({
      state: "input-streaming",
      streamEnded: false,
      input: { title: REAL_TITLE, content },
      errorText: null,
    });
    expect(verdict.died).toBe(false);
  });

  it("calls an input-streaming part dead once the stream has ended", () => {
    const verdict = describeInputStream({
      state: "input-streaming",
      streamEnded: true,
      input: { title: REAL_TITLE, content },
      errorText: null,
    });

    expect(verdict.died).toBe(true);
    if (!verdict.died) {
      return;
    }
    expect(verdict.headline).toMatch(NEVER_FINISHED);
    expect(verdict.detail).toContain(content.length.toLocaleString("en-US"));
    expect(verdict.detail).toContain(REAL_LAST_LINE);
    expect(verdict.continueRequest).toContain(REAL_LAST_LINE);
    expect(verdict.salvage.salvaged).toBe(true);
  });

  it("recognises the marker a finished turn wrote into errorText", () => {
    const verdict = describeInputStream({
      state: "output-error",
      streamEnded: true,
      input: { title: REAL_TITLE, content },
      errorText: `${DEAD_INPUT_STREAM_MARKER} whatever the server wrote`,
    });
    expect(verdict.died).toBe(true);
  });

  it("leaves an ordinary tool error to the ordinary error renderer", () => {
    const verdict = describeInputStream({
      state: "output-error",
      streamEnded: true,
      input: { title: REAL_TITLE, content },
      errorText: "the tool threw",
    });
    expect(verdict.died).toBe(false);
  });

  it("still reports the death when nothing could be salvaged", () => {
    const verdict = describeInputStream({
      state: "input-streaming",
      streamEnded: true,
      input: undefined,
      errorText: null,
    });

    expect(verdict.died).toBe(true);
    if (!verdict.died) {
      return;
    }
    expect(verdict.salvage.salvaged).toBe(false);
    expect(verdict.detail.length).toBeGreaterThan(0);
  });

  it("the surviving arm carries nothing a caller could render as a failure", () => {
    const verdict = describeInputStream({
      state: "output-available",
      streamEnded: true,
      input: { title: "T", content: "c" },
      errorText: null,
    });
    expect(verdict).not.toHaveProperty("headline");
    expect(verdict).not.toHaveProperty("salvage");
  });
});

describe("hasInputStreamEnded", () => {
  const STREAM_ID = "stream-1";

  it("calls the last message alive while the chat is submitting or streaming", () => {
    for (const chatStatus of ["submitted", "streaming"] as const) {
      expect(
        hasInputStreamEnded({
          isLastMessage: true,
          chatStatus,
          activeStreamId: STREAM_ID,
        })
      ).toBe(false);
    }
  });

  it("does not call a message dead in the beat before a reload reattaches its stream", () => {
    expect(
      hasInputStreamEnded({
        isLastMessage: true,
        chatStatus: "ready",
        activeStreamId: STREAM_ID,
      })
    ).toBe(false);
  });

  it("calls the last message dead once the chat has errored, whatever id it still carries", () => {
    // The server's timer aborted the stream: no finish chunk ever cleared the
    // id the client got at start, and the chat banner said "Something went
    // wrong" while the row kept spinning.
    expect(
      hasInputStreamEnded({
        isLastMessage: true,
        chatStatus: "error",
        activeStreamId: STREAM_ID,
      })
    ).toBe(true);
  });

  it("calls a ready message with no stream to wait on dead", () => {
    expect(
      hasInputStreamEnded({
        isLastMessage: true,
        chatStatus: "ready",
        activeStreamId: null,
      })
    ).toBe(true);
  });

  it("keeps an earlier message dead while a continuation streams, even with a stale id", () => {
    // Pressing "Continue" appends a new message and the chat runs again; the
    // dead card above it must not turn back into a spinner.
    for (const chatStatus of [
      "submitted",
      "streaming",
      "ready",
      "error",
    ] as const) {
      expect(
        hasInputStreamEnded({
          isLastMessage: false,
          chatStatus,
          activeStreamId: STREAM_ID,
        })
      ).toBe(true);
    }
  });
});

describe("partial document labelling", () => {
  const salvage = salvageTextDocumentInput({
    title: REAL_TITLE,
    content: buildTruncatedContent(),
  });

  it("marks the title so no list of documents can show it as finished", () => {
    const title = partialDocumentTitle(REAL_TITLE);
    expect(title).toMatch(PARTIAL_AT_START);
    expect(title).toContain(REAL_TITLE);

    // A live copy cut by this tab's own Stop says "stopped", not "stream died"
    // (nothing died); any other live copy and every stored title keep the prefix.
    const stopped = partialDocumentTitle(REAL_TITLE, "stopped");
    expect(stopped).toMatch(PARTIAL_AT_START);
    expect(stopped).toContain("stopped");
    expect(stopped).not.toContain("stream died");
    expect(partialDocumentTitle(REAL_TITLE, "died")).toBe(title);
  });

  it("names the document even when its title never arrived", () => {
    expect(partialDocumentTitle(null)).toMatch(PARTIAL_AT_START);
    expect(partialDocumentTitle(null)).toMatch(UNTITLED);
  });

  it("opens and closes the body with an unmissable partial banner", () => {
    if (!salvage.salvaged) {
      throw new Error("fixture should salvage");
    }
    const body = partialDocumentBody(salvage);

    expect(body.indexOf("PARTIAL DOCUMENT")).toBeLessThan(200);
    expect(body).toContain("THE DOCUMENT STOPS HERE");
    expect(body).toContain(salvage.content);
    expect(body).toContain(salvage.contentChars.toLocaleString("en-US"));
    // A stored copy is the server's own, so it is exact.
    expect(body).toContain("Nothing further was ever written");
    expect(body).not.toContain("at least");
    expect(body).toContain("continue from the last line");
  });

  it("says a live copy holds only what reached this page, and that the saved one may be longer", () => {
    // REGRESSION (live QA, re-check 6): after a Stop the side panel said "97
    // characters in. Nothing further was ever written." while the server had
    // saved 463. A copy a tab rebuilds from the message it was still receiving
    // is not the server's, so it must not claim to be the whole document.
    if (!salvage.salvaged) {
      throw new Error("fixture should salvage");
    }
    const chars = salvage.contentChars.toLocaleString("en-US");
    for (const copy of ["stopped", "died"] as const) {
      const body = partialDocumentBody(salvage, copy);
      expect(body).toContain(`at least ${chars} characters`);
      expect(body).toContain("saved document may be longer");
      expect(body).toContain("reload the chat");
      // The live copy can be shorter than the saved document, so it sends the
      // founder to the saved one rather than to its own last line.
      expect(body).toContain("Reload the chat first");
      expect(body).toContain("continue from the saved document");
      expect(body).not.toContain("continue from the last line");
      expect(body).not.toContain("Nothing further was ever written");
      expect(body).toContain(salvage.content);
      expect(body.split("\n")[0].startsWith("## ")).toBe(true);
    }
    expect(partialDocumentBody(salvage, "stopped")).toContain("was stopped");
    expect(partialDocumentBody(salvage, "stopped")).not.toContain(
      "stream writing"
    );
    expect(partialDocumentBody(salvage, "died")).toContain(
      "The stream writing this document stopped"
    );
  });

  it("uses only markdown the text editor renders, not raw quote or rule marks", () => {
    // Lexical's default import shows "> ##", a bare ">" and "---" as literal
    // characters. The banner and footer are headings and paragraphs instead.
    if (!salvage.salvaged) {
      throw new Error("fixture should salvage");
    }
    const lines = partialDocumentBody(salvage).split("\n");
    expect(lines[0].startsWith("## ")).toBe(true);
    expect(lines.filter((l) => l.startsWith(">") || l === "---")).toEqual([]);
  });
});

describe("sweepDeadInputStreams", () => {
  const dead = {
    type: "tool-createTextDocument",
    toolCallId: "call_1",
    state: "input-streaming",
    input: { title: REAL_TITLE, content: buildTruncatedContent() },
  };

  it("leaves a message with no dead parts completely alone", () => {
    const parts = [
      { type: "text", text: "hello" },
      {
        type: "tool-createTextDocument",
        toolCallId: "call_ok",
        state: "output-available",
        input: { title: "T", content: "c" },
      },
    ];

    const swept = sweepDeadInputStreams(parts);

    expect(swept.deaths).toHaveLength(0);
    expect(swept.announcement).toBeNull();
    expect(swept.parts).toBe(parts);
  });

  it("rewrites a stranded call to output-error carrying the marker", () => {
    const swept = sweepDeadInputStreams([{ type: "text", text: "ok" }, dead]);

    expect(swept.deaths).toHaveLength(1);
    expect(swept.deaths[0].toolCallId).toBe("call_1");
    expect(swept.deaths[0].toolType).toBe("tool-createTextDocument");

    const marked = swept.parts[1] as typeof dead & { errorText: string };
    expect(marked.state).toBe("output-error");
    expect(marked.errorText.startsWith(DEAD_INPUT_STREAM_MARKER)).toBe(true);
    // The salvage must survive the rewrite: `input` is the only copy of the
    // 26KB that arrived, and dropping it here would destroy it for good.
    expect(marked.input).toEqual(dead.input);
  });

  it("keeps every other part in its original order", () => {
    const before = { type: "text", text: "before" };
    const after = { type: "reasoning", text: "after" };
    const swept = sweepDeadInputStreams([before, dead, after]);

    expect(swept.parts).toHaveLength(3);
    expect(swept.parts[0]).toBe(before);
    expect(swept.parts[2]).toBe(after);
  });

  it("writes an announcement that names the loss and how to resume", () => {
    const swept = sweepDeadInputStreams([dead]);

    expect(swept.announcement).not.toBeNull();
    expect(swept.announcement).toContain("never finished");
    expect(swept.announcement).toContain(REAL_LAST_LINE);
    // The renderer leaves this text out beside a dead-document card by
    // recognising its first line, so the two must keep agreeing.
    expect(isDeadStreamAnnouncement(swept.announcement ?? "")).toBe(true);
  });

  it("reports every dead call, not just the first", () => {
    const swept = sweepDeadInputStreams([
      dead,
      { ...dead, toolCallId: "call_2" },
    ]);

    expect(swept.deaths).toHaveLength(2);
    expect(swept.deaths.map((d) => d.toolCallId)).toEqual(["call_1", "call_2"]);
  });

  it("describes a dead non-document call as what it actually was", () => {
    const swept = sweepDeadInputStreams([
      {
        type: "tool-deepResearch",
        toolCallId: "call_r",
        state: "input-streaming",
        input: { topic: "regional pricing" },
      },
    ]);

    expect(swept.deaths).toHaveLength(1);
    const { verdict } = swept.deaths[0];
    expect(verdict.detail).toContain("deepResearch call");
    // It must NOT claim a document was being written, and must not offer to
    // resume one that never existed.
    expect(verdict.detail).not.toContain("writing a document");
    expect(verdict.continueRequest).toContain("deepResearch call");
  });

  it("marks a dead call whose input never arrived at all", () => {
    const swept = sweepDeadInputStreams([
      {
        type: "tool-deepResearch",
        toolCallId: "call_x",
        state: "input-streaming",
      },
    ]);

    expect(swept.deaths).toHaveLength(1);
    expect(swept.deaths[0].verdict.salvage.salvaged).toBe(false);
    expect(swept.announcement).not.toBeNull();
  });

  it("says 'saved' only for a call the route wrote a document for", () => {
    const documentId = "00000000-0000-4000-8000-000000000001";
    const swept = sweepDeadInputStreams(
      [dead, { ...dead, toolCallId: "call_2" }],
      new Map([["call_1", { documentId, kind: "text" as const }]])
    );

    const [savedDeath, unsavedDeath] = swept.deaths;
    expect(savedDeath.verdict.store).toEqual({
      state: "saved",
      documentId,
      kind: "text",
    });
    expect(savedDeath.verdict.detail).toContain("has been saved");
    expect(unsavedDeath.verdict.store).toEqual({ state: "not-saved" });
    expect(unsavedDeath.verdict.detail).not.toContain("has been saved");
    expect(unsavedDeath.verdict.detail).toContain("NOT saved");

    // A reloaded page reads the outcome back from the marked part alone.
    const [savedPart, unsavedPart] = swept.parts as (typeof dead & {
      errorText: string;
    })[];
    const reread = (part: typeof savedPart) =>
      describeInputStream({
        state: part.state,
        streamEnded: true,
        input: part.input,
        errorText: part.errorText,
      });
    const savedAgain = reread(savedPart);
    const unsavedAgain = reread(unsavedPart);
    expect(savedAgain.died && savedAgain.store).toEqual({
      state: "saved",
      documentId,
      kind: "text",
    });
    expect(unsavedAgain.died && unsavedAgain.store).toEqual({
      state: "not-saved",
    });
  });

  it("does not claim a save the live chat cannot know about", () => {
    const verdict = describeInputStream({
      state: "input-streaming",
      streamEnded: true,
      input: dead.input,
      errorText: null,
    });
    expect(verdict.died && verdict.store).toEqual({ state: "unknown" });
    expect(verdict.died && verdict.detail).not.toContain("has been saved");
  });

  it("tells a stranded part no reload can explain that it was not saved", () => {
    // Loaded from storage: no activeStreamId, no marker. The server finished
    // with this turn long ago and recorded nothing, so "reload to see whether
    // it was saved" would be a dead end.
    const verdict = describeInputStream({
      state: "input-streaming",
      streamEnded: true,
      input: dead.input,
      errorText: null,
      reloadMayAnswer: false,
    });
    expect(verdict.died && verdict.store).toEqual({ state: "not-saved" });
    expect(verdict.died && verdict.detail).toContain("NOT saved");
    expect(verdict.died && verdict.detail).not.toContain("Reload the chat");
  });

  it("keeps the reload hint for a turn that just died in this tab", () => {
    const verdict = describeInputStream({
      state: "input-streaming",
      streamEnded: true,
      input: dead.input,
      errorText: null,
      reloadMayAnswer: true,
    });
    expect(verdict.died && verdict.store).toEqual({ state: "unknown" });
    expect(verdict.died && verdict.detail).toContain("Reload the chat");
  });

  it("counts a live copy as what arrived here, and a Stop as stopped, not as a stream that failed", () => {
    // REGRESSION (live QA, re-check 6): the live card said "stopped after 97
    // characters" for a Stop whose server saved 463, and the reloaded card said
    // 463. A count the server has not confirmed is a lower bound.
    const chars = dead.input.content.length.toLocaleString("en-US");
    const live = describeInputStream({
      state: "input-streaming",
      streamEnded: true,
      input: dead.input,
      errorText: null,
      reloadMayAnswer: true,
    });
    expect(live.died && live.detail).toContain(
      `stopped after at least ${chars} characters had arrived here`
    );
    expect(live.died && live.detail).toContain(
      "may be shorter than the saved one"
    );

    const stopped = describeInputStream({
      state: "input-streaming",
      streamEnded: true,
      input: dead.input,
      errorText: null,
      reloadMayAnswer: true,
      stoppedHere: true,
    });
    expect(stopped.died && stopped.detail).toContain(
      `the reply was stopped after at least ${chars} characters had arrived here`
    );
    expect(stopped.died && stopped.detail).not.toContain(
      "the stream carrying it"
    );

    // A count the server has answered for stays exact, Stop or not.
    const exact = describeInputStream({
      state: "input-streaming",
      streamEnded: true,
      input: dead.input,
      errorText: null,
      reloadMayAnswer: false,
      stoppedHere: true,
    });
    expect(exact.died && exact.detail).toContain(`after ${chars} characters.`);
    expect(exact.died && exact.detail).not.toContain("at least");
  });

  it("ignores non-tool parts that happen to carry a state field", () => {
    const swept = sweepDeadInputStreams([
      { type: "data-research", state: "input-streaming" },
    ]);
    expect(swept.deaths).toHaveLength(0);
  });
});

describe("a marked part still persists", () => {
  /**
   * The rewrite is only worth anything if it reaches the database. Parts are
   * validated on the way in (lib/utils/message-part-validators.ts) and a part
   * that fails validation is silently DROPPED by `handleToolPartToDB`, which
   * would turn "the failure is now recorded" into "the tool call vanished
   * entirely" — a worse outcome than the bug being fixed.
   */
  it("passes the tool-part validator the route persists through", () => {
    const swept = sweepDeadInputStreams([
      {
        type: "tool-createTextDocument",
        toolCallId: "call_1",
        state: "input-streaming",
        input: { title: REAL_TITLE, content: buildTruncatedContent() },
      },
    ]);

    const result = validateToolPart(swept.parts[0]);

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.state).toBe("output-error");
    // `tool_input` is the column the 26KB actually lives in. If the validator
    // dropped it, the salvage would be a one-time rescue rather than a record.
    expect(result.data.input).toEqual({
      title: REAL_TITLE,
      content: buildTruncatedContent(),
    });
  });
});
