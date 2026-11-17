import { randomBytes } from "node:crypto";
import {
  generateText,
  type ModelMessage,
  stepCountIs,
  ToolLoopAgent,
} from "ai";
import type { AppModelId, ModelId } from "@/lib/ai/app-models";
import { getLanguageModel } from "@/lib/ai/providers";
import { countTextTokens } from "@/lib/ai/token-utils";
import { createModuleLogger } from "@/lib/logger";
import {
  buildCompressionPrompt,
  compressionFrameTags,
} from "./compression-input";
import {
  compressResearchSimpleHumanMessage,
  compressResearchSystemPrompt,
  researchSystemPrompt,
} from "./prompts";
import { recordCut, stopAt } from "./research-clock";
import { type AgentOptions, createTelemetry } from "./types";
import { getAllTools, getModelContextWindow, getTodayStr } from "./utils";

const log = createModuleLogger("tools/deep-research/researcher-agent");

export async function runResearcher(
  topic: string,
  options: AgentOptions
): Promise<string> {
  const { audience, clock, config, dataStream, toolCallId, abortSignal } =
    options;

  // The least thinking the model takes, so a step's thinking leaves its cap to
  // the tool call (lib/ai/call-paths.ts, "researcherStep").
  const model = await getLanguageModel(
    config.research_model as ModelId,
    "researcherStep"
  );
  // `audience` rides along so the sidecar arm can rank its lanes against the
  // founder's buyer. The cloud arms ignore it: Tavily and Firecrawl are single
  // opaque lanes, so there is nothing to rank. `clock` lets the sidecar arm
  // cap each search step and refuse one that cannot finish in time.
  const tools = await getAllTools(
    config,
    dataStream,
    toolCallId,
    audience,
    clock
  );

  if (Object.keys(tools).length === 0) {
    throw new Error(
      "No tools found to conduct research: Please configure either your search API or add MCP tools to your configuration."
    );
  }

  dataStream.write({
    type: "data-researchUpdate",
    data: {
      toolCallId,
      title: "Starting research on topic",
      message: topic,
      type: "thoughts",
      status: "running",
    },
  });

  let finishedMessages: ModelMessage[] = [];
  // Timing of this researcher's own steps, for the log (see `onStepFinish`).
  let stepsFinished = 0;
  let lastStepFinishedAt = clock.now();

  const researcherAgent = new ToolLoopAgent({
    model,
    instructions: researchSystemPrompt({
      mcp_prompt: config.mcp_prompt || "",
      date: getTodayStr(),
      max_search_queries: config.search_api_max_queries,
    }),
    tools,
    // EXPLICIT, and it must stay explicit. ToolLoopAgent defaults stopWhen to
    // stepCountIs(20) (ai@6.0.219, the `stopWhen` fallback in ToolLoopAgent's
    // call arguments), so omitting this does
    // not mean one pass — it means up to twenty model round trips per topic,
    // times max_concurrent_research_units, times the supervisor's iterations.
    // The supervisor next door has always bounded itself; this agent was
    // silently inheriting that 20.
    stopWhen: [
      stepCountIs(config.max_researcher_steps),
      // Evaluated only when the last step called a tool, i.e. when the
      // researcher wanted to search again. Past the search deadline it stops.
      () => {
        if (clock.now() < clock.searchStopAt) {
          return false;
        }
        recordCut(
          clock,
          "a researcher stopped searching at the search deadline",
          { stepsFinished },
          topic
        );
        return true;
      },
    ],
    // PER STEP, reasoning included, and deliberately far below the 4,000 the
    // other roles get: see `researcher_step_max_tokens` in configuration.ts.
    maxOutputTokens: config.researcher_step_max_tokens,
    experimental_telemetry: createTelemetry("researcher", options),
    onStepFinish: ({ usage, response, toolCalls, finishReason }) => {
      // Cumulative: each step's response carries every message so far, with
      // each tool call next to its result. Kept so a researcher stopped at
      // the deadline still hands its finished steps to compression.
      finishedMessages = response.messages;

      // WHERE THE SEARCH WINDOW GOES, per model step. Live QA (2026-11-12)
      // saw every search finish within about 12 s of the researchers starting
      // and then each researcher sit in ONE model step until the search stop,
      // 82 s later, with nothing to say which step it was or how long it had
      // been running. A step that finishes is logged here with its length and
      // what it did; one that is cut mid-step is logged by `recordCut` below,
      // with how long it had been running.
      const finishedAt = clock.now();
      stepsFinished += 1;
      log.info(
        {
          step: stepsFinished,
          stepSeconds: Math.round((finishedAt - lastStepFinishedAt) / 100) / 10,
          toolCalls: toolCalls.map((call) => call.toolName),
          finishReason,
          outputTokens: usage?.outputTokens,
          reasoningTokens: usage?.outputTokenDetails?.reasoningTokens,
          secondsUntilSearchStop:
            Math.round(Math.max(0, clock.searchStopAt - finishedAt) / 100) / 10,
        },
        "researcher step finished"
      );
      lastStepFinishedAt = finishedAt;

      if (finishReason === "length") {
        // Logged loudly: with brief notes asked for, hitting the cap means the
        // reasoning or the reply ran far past what was measured.
        log.warn(
          {
            step: stepsFinished,
            outputTokens: usage?.outputTokens,
            reasoningTokens: usage?.outputTokenDetails?.reasoningTokens,
            toolCalls: toolCalls.map((call) => call.toolName),
          },
          "researcher step hit its output cap"
        );
      }

      if (usage) {
        options.costAccumulator?.addLLMCost(
          config.research_model as AppModelId,
          usage,
          "deep-research-researcher"
        );
      }
    },
  });

  const stop = stopAt(clock, clock.searchStopAt, abortSignal);
  let researchMessages: ModelMessage[];
  try {
    const { response, finishReason } = await researcherAgent.generate({
      prompt: topic,
      abortSignal: stop.signal,
    });
    // The closing reply hit the output cap. It is notes, and the findings are
    // condensed from the search results, so the cut-off text is dropped and
    // nothing else is lost: no retry, no error, and no "cut short" for time.
    // A DECLINED STEP (Claude's `refusal`, `content-filter`, empty or partial
    // and no error) ends the loop the same way, and its reply is dropped too:
    // compression would only be handed a refusal to condense.
    const declined = finishReason === "content-filter";
    researchMessages =
      finishReason === "length" || declined
        ? withoutTruncatedReply(response.messages)
        : response.messages;
    // Unlike a cut-off reply, a declined one is a cut: the researcher meant to
    // go on. The report is told, with the topic, whether any search ran before
    // it; with none, the topic ends as NOT RESEARCHED below and the paid
    // compression call is skipped.
    if (declined) {
      log.warn(
        { stepsFinished, searched: researchMessages.length > 0 },
        "a researcher's model declined to continue"
      );
      recordCut(
        clock,
        researchMessages.length > 0
          ? "a researcher's model declined to continue, so its topic was researched only as far as it had got"
          : "a researcher's model declined to research its topic, so that topic was not researched",
        {},
        topic
      );
    }
    // EXCEPT WHEN THERE WAS NO SEARCH BEHIND IT. A researcher whose very first
    // reply hit the cap (the model wrote prose, or reasoned, instead of
    // searching) has nothing left once that reply is dropped, and the topic ends
    // as "NOT RESEARCHED" below. That is a topic that went unresearched, so the
    // report is told, exactly as it is for a topic the clock never started.
    if (finishReason === "length" && researchMessages.length === 0) {
      recordCut(
        clock,
        "a researcher's first reply was cut off at its output limit before it searched, so its topic was not researched",
        // No `stepsFinished`: that step finished, but searched nothing, and the
        // report would read "1 search step had finished" as a search.
        {},
        topic
      );
    }
  } catch (error) {
    // Only the planned search deadline is absorbed; the route's abort and
    // every real failure still propagate. The step in flight is lost, the
    // steps before it are kept.
    if (!stop.stoppedByDeadline()) {
      throw error;
    }
    recordCut(
      clock,
      "a researcher was stopped mid-step at the search deadline",
      {
        stepsFinished,
        // How long the step that was cut had been running.
        unfinishedStepSeconds:
          Math.round((clock.now() - lastStepFinishedAt) / 100) / 10,
      },
      topic
    );
    researchMessages = finishedMessages;
  }

  // Nothing finished: there is nothing to condense, and a compression call over
  // an empty transcript would be paid for nothing.
  const compressed =
    researchMessages.length === 0
      ? `NOT RESEARCHED: no search for this topic finished (the search time ran out, or the researcher's first reply was cut off or declined). Topic: ${topic}`
      : await compressResearch(researchMessages, options, topic);

  dataStream.write({
    type: "data-researchUpdate",
    data: {
      toolCallId,
      title: "Research topic completed",
      message: topic,
      type: "thoughts",
      status: "completed",
    },
  });

  return compressed;
}

/**
 * PURE. The researcher's messages without a closing reply that was cut off at
 * the output cap. Only a trailing assistant message goes: the searches (the
 * assistant's tool calls and their results, which end in a tool message) stay,
 * and a reply that ended a loop cleanly is never passed through here.
 */
function withoutTruncatedReply(messages: ModelMessage[]): ModelMessage[] {
  return messages.at(-1)?.role === "assistant"
    ? messages.slice(0, -1)
    : messages;
}

async function compressResearch(
  researchMessages: ModelMessage[],
  options: AgentOptions,
  topic: string
): Promise<string> {
  const { config, abortSignal } = options;
  // The lowest reasoning effort the model takes, so reasoning does not eat the
  // output cap (lib/ai/call-paths.ts, "compression").
  const model = await getLanguageModel(
    config.compression_model as ModelId,
    "compression"
  );

  // Tag names no fetched page can know: drawn now, after every search ran
  // (`compressionFrameTags`), and named in both the system prompt and the
  // user message.
  const tags = compressionFrameTags(randomBytes(6).toString("hex"));
  const system = compressResearchSystemPrompt({ date: getTodayStr(), tags });
  const contextWindow = await getModelContextWindow(
    config.compression_model as ModelId
  );
  // ONE user message, the research as text: no tool blocks and no assistant
  // turn are replayed (see compression-input.ts for the two 400s that caused).
  //
  // ISSUE #189: this is the only place with real history to fit into a window.
  // Over budget, `buildCompressionPrompt` leaves out the OLDEST search results
  // first and always keeps the topic, every call line and the closing
  // instruction; what it left out is logged below. Left as a cut rather than a
  // carry-over deliberately — a research loop is stateless between runs, so
  // nothing durable is lost here. The phase workflow solves the same problem
  // the other way: lib/phases/extract.ts distils turns into project facts and
  // lib/phases/context.ts re-injects them, ranked and budgeted, into every
  // system prompt, so state survives truncation instead of being raced by it.
  // Use that pattern if this loop ever needs to remember something across calls.
  const input = buildCompressionPrompt({
    topic,
    messages: researchMessages,
    tags,
    system,
    instruction: compressResearchSimpleHumanMessage,
    contextWindow,
    maxOutputTokens: config.compression_model_max_tokens,
    countTokens: countTextTokens,
  });
  if (
    input.resultsLeftOut > 0 ||
    input.newestResultCut ||
    input.entriesDropped > 0
  ) {
    log.warn(
      {
        resultsLeftOut: input.resultsLeftOut,
        newestResultCut: input.newestResultCut,
        entriesDropped: input.entriesDropped,
        contextWindow,
      },
      "research log was over the compression model's window: the oldest results were left out"
    );
  }

  // Compression must finish by `compressionDueAt` so the report keeps its
  // time (research-clock.ts). Stopped there, the researcher's own words and
  // search results go forward uncondensed rather than being lost.
  const stop = stopAt(
    options.clock,
    options.clock.compressionDueAt,
    abortSignal
  );
  let response: Awaited<ReturnType<typeof generateText>>;
  try {
    response = await generateText({
      model,
      system,
      prompt: input.prompt,
      maxOutputTokens: config.compression_model_max_tokens,
      experimental_telemetry: createTelemetry("compressResearch", options),
      maxRetries: 3,
      abortSignal: stop.signal,
    });
  } catch (error) {
    if (!stop.stoppedByDeadline()) {
      throw error;
    }
    recordCut(
      options.clock,
      "condensing a researcher's findings was stopped, so they were passed on uncondensed",
      {},
      topic
    );
    return uncondensedFindings(researchMessages);
  }

  if (response.usage) {
    options.costAccumulator?.addLLMCost(
      config.compression_model as AppModelId,
      response.usage,
      "deep-research-compress"
    );
  }

  // A DECLINED COMPRESSION IS A CUT, NEVER EMPTY NOTES. Claude's `refusal`
  // stop reason arrives as `content-filter`, with no error and an empty or
  // partial text. Returned as it came, that was this topic's findings: the
  // report dropped the topic and its "Research cut short" section never named
  // it. So it is recorded as a cut for this topic, and the notes say what
  // happened, after whatever text did arrive. Checked before `length`: a
  // declined call is not a full one.
  if (response.finishReason === "content-filter") {
    log.warn(
      { outputTokens: response.usage?.outputTokens },
      "the compression model declined to condense a researcher's findings"
    );
    recordCut(options.clock, COMPRESSION_DECLINED_REASON, {}, topic);
    const partial = response.text.trim();
    return partial.length > 0
      ? `${partial}\n\n${COMPRESSION_DECLINED_NOTE}`
      : COMPRESSION_DECLINED_NOTE;
  }

  // THE CAP IS NOT RAISED (it is the time budget: `compression_model_max_tokens`
  // is what fits the 30 s compression allowance), but a note that stops at it is
  // not a finished note. Live QA (2026-11-12) saw one compression call end at
  // exactly 4,000 output tokens with nothing said anywhere. It is logged, the
  // notes carry a last line saying they are incomplete, because the report writer
  // reads them as the researcher's whole findings, AND it is recorded as a cut
  // for this topic: the report's "Research cut short" section is filled "from the
  // list and nothing more", so a cut that is only in the notes' last line is a cut
  // the report is told nothing of.
  if (response.finishReason === "length") {
    log.warn(
      {
        outputTokens: response.usage?.outputTokens,
        reasoningTokens: response.usage?.outputTokenDetails?.reasoningTokens,
        maxOutputTokens: config.compression_model_max_tokens,
      },
      "condensed research notes hit the output cap"
    );
    recordCut(options.clock, COMPRESSION_CUT_OFF_REASON, {}, topic);
    return `${response.text}\n\n${COMPRESSION_CUT_OFF_NOTE}`;
  }

  return response.text;
}

/**
 * The cut the report is told about when a researcher's compressed notes ended at
 * the output cap. Not about time: the notes exist, and their end is missing.
 */
const COMPRESSION_CUT_OFF_REASON =
  "a researcher's condensed notes were cut off at the output limit, so findings and sources from the end of that researcher's work are missing";

/** The last line of compressed notes that were cut off at the output cap. */
const COMPRESSION_CUT_OFF_NOTE =
  "[These notes were cut off at the output limit and are incomplete: findings and sources from the end of this researcher's work are missing.]";

/**
 * The cut the report is told about when the model declined to condense a
 * researcher's findings (`content-filter`). Not about time or length.
 */
const COMPRESSION_DECLINED_REASON =
  "the model declined to condense a researcher's findings, so that researcher's findings are missing or incomplete";

/** The notes of a topic whose compression the model declined. */
const COMPRESSION_DECLINED_NOTE =
  "[The model declined to condense this researcher's findings, so they are missing or incomplete here.]";

/**
 * Enough of the raw transcript to cite from, bounded so that several of these
 * cannot crowd the report prompt. 12,000 characters is roughly 3,000 tokens,
 * about what a compression call would have written.
 */
const UNCONDENSED_FINDINGS_MAX_CHARS = 12_000;

/** PURE. The researcher's text and tool results, as plain text. */
function uncondensedFindings(messages: readonly ModelMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      parts.push(message.content);
      continue;
    }
    for (const part of message.content) {
      if (part.type === "text") {
        parts.push(part.text);
      } else if (part.type === "tool-result") {
        parts.push(JSON.stringify(part.output));
      }
    }
  }
  const body = parts.join("\n\n").slice(0, UNCONDENSED_FINDINGS_MAX_CHARS);
  return `UNCONDENSED FINDINGS (condensing was stopped for time; these are the researcher's own notes and raw search results):\n\n${body}`;
}
