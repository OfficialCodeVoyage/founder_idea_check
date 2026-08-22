/**
 * WHAT ACTUALLY HAPPENED WHEN NO DOCUMENT CAME BACK.
 *
 * This branch used to return the flat string "createTextDocument tool was not
 * called", and on 2026-08-21 that string was FALSE. `createTextDocument` had
 * been called, with 26,731 characters of the founder's report; it was the
 * RESULT that never arrived. The sentence sent the founder — and a whole
 * investigation — after the wrong tool, and it tangled two unrelated failures
 * into one wrong diagnosis.
 *
 * The stream knows the difference and was never asked. `toolCalls` says whether
 * the model reached for the tool; `finishReason` says how the stream ended. So
 * ask, and name the branch that actually fired:
 *
 * - called, no result   the document write started and did not come back.
 * - never called        the model wrote prose instead of saving anything.
 *
 * Both are still `status: "error"` — a report the founder cannot open is not a
 * report — but they are different bugs and they now read as different bugs.
 */
export async function describeMissingReportDocument(result: {
  // `PromiseLike`, not `Promise`: the AI SDK's StreamTextResult exposes these as
  // PromiseLike, and widening the parameter is what keeps this function a pure,
  // testable read of the stream instead of something that needs a live one.
  finishReason: PromiseLike<string>;
  toolCalls: PromiseLike<readonly { toolName: string }[]>;
  text: PromiseLike<string>;
}): Promise<string> {
  const finishReason = await result.finishReason;
  const attempts = (await result.toolCalls).filter(
    (call) => call.toolName === "createTextDocument"
  );

  if (attempts.length > 0) {
    return `The report was written and the createTextDocument tool WAS called ${attempts.length === 1 ? "once" : `${attempts.length} times`}, but no result came back before the stream ended (finish reason: ${finishReason}). The report exists in the model's output and was not saved, so there is no document to open.`;
  }

  const prose = (await result.text).trim();
  return `The report model ended (finish reason: ${finishReason}) without ever calling createTextDocument, so nothing was saved. It emitted ${prose.length} characters of plain text instead of a document.`;
}
