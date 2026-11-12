/**
 * WHAT TO DO WITH A `createTextDocument` CALL WHOSE INPUT STREAM DIED.
 *
 * Observed live on 2026-08-21 in a local QA database, as a `Part` row with
 * `tool_state = 'input-streaming'`,
 * `tool_input` 26,731 characters, `tool_output` 0 bytes, `tool_errorText` NULL,
 * and no `Document` row anywhere. The content ends mid-table-row inside the
 * INTENSITY rubric, at score 3. THE FOUNDER HAD TO NOTICE AND REPORT IT — the
 * turn that lost it produced zero text characters and said nothing.
 *
 * `input-streaming` is an ACCURATE state, not a botched transition: the input
 * genuinely never finished arriving, so the tool could never execute, write a
 * document, or throw. That is precisely why it was invisible. Nothing
 * distinguishes a call whose input is still arriving from one whose input
 * stopped arriving forever, so the UI rendered the second as the first and
 * waited.
 *
 * This module supplies the two halves the incident asked for:
 *
 *   DETECT  `describeInputStream` — a stream that ended while a tool part was
 *           still in `input-streaming` is a FAILURE, and it says so in words a
 *           founder can act on, including the line it stopped after.
 *   SALVAGE `salvageTextDocumentInput` — 26KB of content behind a title is a
 *           RECOVERABLE DOCUMENT, not garbage. A human had to recover that
 *           exact payload by hand (Incident 6 in docs/INCIDENTS.md); this is
 *           the product doing it automatically.
 *
 * PURE. No database, no clock, no React. Both the route (server, at finalize)
 * and the tool renderer (client, live) read the same functions, so the chat and
 * the persisted message cannot disagree about whether a stream died.
 */

import type { ChatStatus } from "ai";
import {
  type ArtifactKind,
  artifactKinds,
} from "@/lib/artifacts/artifact-kind";

/**
 * The prefix stamped into `tool_errorText` when the server marks a dead input
 * stream at finalize time.
 *
 * IT IS A SENTINEL IN A TEXT COLUMN ON PURPOSE. `Part` has no column for "this
 * failure was a dead input stream" and adding one is a migration; the whole
 * point of this change is that it ships without touching the schema that
 * already holds the stranded rows. The marker is matched with `startsWith`, and
 * the human-readable detail follows it, so the same string serves the model
 * (which now receives a tool error instead of silence) and the reader.
 */
export const DEAD_INPUT_STREAM_MARKER = "[dead-input-stream]";

/**
 * Follows DEAD_INPUT_STREAM_MARKER in `tool_errorText` when, and only when, the
 * route actually wrote the salvaged prefix as a `Document`:
 * `[dead-input-stream] [partial-document:<kind>:<documentId>] <detail>`, with
 * `:stopped` after the id when the founder's own Stop cut the stream.
 *
 * Same reasoning as the marker itself: `Part` has no column for it, and the
 * output-error part is the one place a reloaded page reads the outcome back
 * from. A marker with no tag means the server decided and saved nothing. The
 * `:stopped` is there because the stored title says "stopped" for such a turn
 * (`partialDocumentTitle`), and the panel header a reloaded card opens it under
 * must say the same; a tag without it (every one written before it existed) is a
 * stream that died, as its title says.
 */
const SAVED_DOCUMENT_TAG =
  /^ \[partial-document:([a-z]+):([^\]\s:]+)(:stopped)?\]/;

/**
 * WHETHER THE SALVAGED PREFIX WAS WRITTEN AS A DOCUMENT.
 *
 * Three states because three are real. The server knows `saved` or
 * `not-saved` once it has tried; the live chat, which renders the dead card
 * the moment the stream stops, knows neither until the page is reloaded and
 * the marked part comes back. Saying "saved" from there would be a guess.
 *
 * `unknown` therefore means "a reload can answer this", and only that. A part
 * the server has already finished with and left unmarked is `not-saved`: no
 * reload will ever change it, so telling the founder to reload would send them
 * to a page that says the same thing.
 */
export type PartialDocumentStore =
  | {
      readonly state: "saved";
      readonly documentId: string;
      readonly kind: ArtifactKind;
      /** The stored copy is titled and worded as a Stop's (`SavedPartialDocument`). */
      readonly stoppedByUser?: boolean;
    }
  | { readonly state: "not-saved" }
  | { readonly state: "unknown" };

/** A document the route wrote for a dead call: its id and the kind it was written as. */
export type SavedPartialDocument = {
  readonly documentId: string;
  readonly kind: ArtifactKind;
  /**
   * The founder's own Stop cut the stream, so the route titled and worded the
   * document "stopped" and not "stream died". Absent and false are the same.
   */
  readonly stoppedByUser?: boolean;
};

function isArtifactKind(value: string): value is ArtifactKind {
  return (artifactKinds as readonly string[]).includes(value);
}

/** Read back what the server recorded in a marked part's `errorText`. */
function readStoreFromErrorText(errorText: string): PartialDocumentStore {
  const tag = errorText
    .slice(DEAD_INPUT_STREAM_MARKER.length)
    .match(SAVED_DOCUMENT_TAG);
  if (tag && isArtifactKind(tag[1])) {
    return {
      state: "saved",
      kind: tag[1],
      documentId: tag[2],
      ...(tag[3] ? { stoppedByUser: true } : {}),
    };
  }
  return { state: "not-saved" };
}

/**
 * A `\uXXXX` escape whose hex digits did not all arrive, anchored at the end.
 * Hoisted only to satisfy lint/performance/useTopLevelRegex; it belongs to
 * `trimIncompleteEscape` below.
 */
const INCOMPLETE_UNICODE_ESCAPE = /\\u[0-9a-fA-F]{0,3}$/;

/** How much of the final line to quote back. Long enough to find it in a doc. */
const STOPPED_AFTER_MAX_CHARS = 240;

/**
 * WHAT SURVIVED THE DEAD STREAM.
 *
 * THE UNSALVAGEABLE ARM CARRIES NO DOCUMENT TO READ. No `content`, no `title`,
 * no `contentChars` — so a caller cannot reach for an empty string and write a
 * blank document, and cannot report "0 characters recovered" as though zero
 * were a measurement. Same technique as `AttemptDetail` in
 * lib/phases/attempt-history.ts and `GateVerdictView` in lib/phases/rail.ts,
 * for the same reason: six separate bugs in this codebase were a zero standing
 * in for an unknown.
 */
export type SalvagedTextDocument =
  | {
      readonly salvaged: false;
      /** Why there is nothing to recover. Never blank. */
      readonly why: string;
    }
  | {
      readonly salvaged: true;
      /**
       * NULL when the stream died before the title key arrived.
       *
       * Not `""`. An empty title would be rendered as a document that is
       * genuinely called nothing, and `partialDocumentTitle` would have no way
       * to tell "the founder named it nothing" from "we never found out".
       */
      readonly title: string | null;
      /** Everything that arrived. Never empty, never whitespace-only. */
      readonly content: string;
      readonly contentChars: number;
      /**
       * The last line as it arrived — usually itself half-written. This is the
       * anchor a continuation resumes from, and it is the exact thing the
       * founder had to work out by hand: *"The response truncated inside
       * INTENSITY, score 3. Complete the protocol from that point."*
       */
      readonly stoppedAfter: string;
      /**
       * `partial-object` the AI SDK's partial-JSON parser had already turned
       *                  the prefix into `{ title, content }`. The live case.
       * `json-prefix`    the raw truncated JSON text was all we had, and the
       *                  string literals were walked out of it by hand.
       */
      readonly recoveredFrom: "partial-object" | "json-prefix";
    };

/**
 * WHETHER THIS TOOL PART IS A CORPSE.
 *
 * THE SURVIVING ARM CARRIES NO FAILURE TO RENDER. `died: false` has no
 * headline, no detail and no salvage, so no caller can paint a live tool call —
 * or a completed one — as a loss.
 */
export type InputStreamVerdict =
  | { readonly died: false }
  | {
      readonly died: true;
      /** One line, for the heading of the failure card. */
      readonly headline: string;
      /** What was lost, how much survived, and where it stopped. */
      readonly detail: string;
      /** A ready-made message the founder can send to resume the document. */
      readonly continueRequest: string;
      readonly salvage: SalvagedTextDocument;
      /** Whether what was salvaged was written as a `Document`. `detail` follows it. */
      readonly store: PartialDocumentStore;
    };

const NOT_AN_OBJECT =
  "the tool call carried no input at all when the stream ended, so there is nothing to recover — the request has to be made again from scratch";

const TITLE_ONLY =
  "the input stream stopped before any document content arrived, so there is no partial document to save — whatever had been sent is not enough to recover";

/**
 * The document tools, by bare name.
 *
 * The sweep marks EVERY tool call that died mid-input, not just document ones,
 * because a silently dead `deepResearch` is the same defect wearing a different
 * hat. But only these have a `{ title, content }` input that can become a
 * partial document, so only these get told they were writing one — describing a
 * dead research call as a lost document would be its own small lie.
 */
const DOCUMENT_TOOL_NAMES = new Set([
  "createTextDocument",
  "createCodeDocument",
  "createSheetDocument",
  "editTextDocument",
  "editCodeDocument",
  "editSheetDocument",
]);

function whatWasBeingWritten(toolType: string | undefined): string {
  if (!toolType) {
    return "writing a document";
  }
  const name = toolType.replace("tool-", "");
  return DOCUMENT_TOOL_NAMES.has(name)
    ? "writing a document"
    : `a ${name} call`;
}

function lastArrivedLine(content: string): string {
  const lines = content.split("\n");
  // Walk back past trailing blank lines: a document that stopped just after a
  // newline stopped after the last line that had words in it, not after "".
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.length > 0) {
      return line.length > STOPPED_AFTER_MAX_CHARS
        ? `${line.slice(0, STOPPED_AFTER_MAX_CHARS)}…`
        : line;
    }
  }
  return content.trim().slice(0, STOPPED_AFTER_MAX_CHARS);
}

function asSalvaged(
  title: string | null,
  content: string,
  recoveredFrom: "partial-object" | "json-prefix"
): SalvagedTextDocument {
  if (content.trim().length === 0) {
    return { salvaged: false, why: TITLE_ONLY };
  }
  return {
    salvaged: true,
    title,
    content,
    contentChars: content.length,
    stoppedAfter: lastArrivedLine(content),
    recoveredFrom,
  };
}

/**
 * Trim a JSON string literal's body back to the last point that can be decoded.
 *
 * A stream can die anywhere, including three characters into `⚠`. Those
 * three characters name no codepoint, so they are dropped rather than guessed
 * at or turned into a replacement character — an invented character in a
 * salvaged document is the same class of lie as an unlabelled partial.
 */
function trimIncompleteEscape(body: string): string {
  const uEscape = body.match(INCOMPLETE_UNICODE_ESCAPE);
  if (uEscape) {
    return body.slice(0, body.length - uEscape[0].length);
  }
  // An ODD number of trailing backslashes means the last one is opening an
  // escape whose second character never arrived. An even number is a complete
  // run of escaped backslashes and must be kept.
  let backslashes = 0;
  for (let i = body.length - 1; i >= 0 && body[i] === "\\"; i--) {
    backslashes++;
  }
  return backslashes % 2 === 1 ? body.slice(0, -1) : body;
}

/**
 * Read the JSON string literal that starts at `open` (the opening quote).
 *
 * Returns the DECODED value, or null when the literal is so short that nothing
 * decodable arrived. The literal is allowed to be unterminated — that is the
 * whole reason this exists instead of `JSON.parse`.
 */
function readStringLiteral(source: string, open: number): string | null {
  let end = open + 1;
  while (end < source.length) {
    const ch = source[end];
    if (ch === "\\") {
      end += 2;
      continue;
    }
    if (ch === '"') {
      break;
    }
    end++;
  }
  const body = trimIncompleteEscape(
    source.slice(open + 1, Math.min(end, source.length))
  );
  try {
    return JSON.parse(`"${body}"`) as string;
  } catch {
    return null;
  }
}

/** Find `"key":` and return the index of its value's opening quote. */
function findStringValue(source: string, key: string): string | null {
  const at = source.indexOf(`"${key}"`);
  if (at === -1) {
    return null;
  }
  const colon = source.indexOf(":", at + key.length + 2);
  if (colon === -1) {
    return null;
  }
  const open = source.indexOf('"', colon + 1);
  if (open === -1) {
    return null;
  }
  return readStringLiteral(source, open);
}

function salvageFromJsonPrefix(source: string): SalvagedTextDocument {
  // A prefix that happens to be whole is still a prefix as far as this function
  // is concerned; parsing it properly is simply the better answer when it works.
  try {
    const parsed: unknown = JSON.parse(source);
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      return asSalvaged(
        typeof record.title === "string" ? record.title : null,
        typeof record.content === "string" ? record.content : "",
        "json-prefix"
      );
    }
  } catch {
    // Expected: this is the truncated case, and it is the case that matters.
  }

  const content = findStringValue(source, "content");
  if (content === null) {
    return { salvaged: false, why: TITLE_ONLY };
  }
  return asSalvaged(findStringValue(source, "title"), content, "json-prefix");
}

/**
 * Recover whatever the dead input stream managed to deliver.
 *
 * Two shapes reach here and both are real:
 *
 *  - An OBJECT. The AI SDK feeds tool input through a partial-JSON parser as it
 *    streams, so the frozen row in the database holds a perfectly valid
 *    `{ title, content }` object whose `content` simply stops mid-sentence.
 *    Nothing needs parsing; it needs *believing*, which is what nothing did.
 *  - A STRING. The raw truncated JSON, which by definition will not parse. Its
 *    string literals are walked out of the prefix by hand.
 */
export function salvageTextDocumentInput(input: unknown): SalvagedTextDocument {
  if (typeof input === "string") {
    return input.trim().length === 0
      ? { salvaged: false, why: NOT_AN_OBJECT }
      : salvageFromJsonPrefix(input);
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { salvaged: false, why: NOT_AN_OBJECT };
  }
  const record = input as Record<string, unknown>;
  return asSalvaged(
    typeof record.title === "string" ? record.title : null,
    typeof record.content === "string" ? record.content : "",
    "partial-object"
  );
}

const HEADLINE = "This document never finished being written";

/**
 * The first line of every announcement `sweepDeadInputStreams` writes, and the
 * only thing that tells a stored text part apart from ordinary assistant prose.
 * Defined from `HEADLINE` so the composer below and `isDeadStreamAnnouncement`
 * cannot drift apart.
 */
const ANNOUNCEMENT_LEAD = `**${HEADLINE}.**`;

/** Whether a stored text part is the announcement the route appends for a dead call. */
export function isDeadStreamAnnouncement(text: string): boolean {
  return text.startsWith(ANNOUNCEMENT_LEAD);
}

/** Whether a tool part carries DEAD_INPUT_STREAM_MARKER, i.e. the route has swept it. */
export function isMarkedDeadInputStream(part: {
  readonly type: string;
  readonly state?: unknown;
  readonly errorText?: unknown;
}): boolean {
  return (
    part.state === "output-error" &&
    typeof part.errorText === "string" &&
    part.errorText.startsWith(DEAD_INPUT_STREAM_MARKER)
  );
}

/**
 * The sentence about where the salvage went. It is only ever as strong as
 * `store`: "has been saved" is said only for a document the route wrote.
 */
function whereItWent(store: PartialDocumentStore): string {
  switch (store.state) {
    case "saved":
      return "What arrived has been saved as a PARTIAL document — it is labelled partial in its title and at the top and bottom of its body, because a partial passed off as finished would be worse than losing it.";
    case "not-saved":
      return "What arrived was NOT saved as a document. It survives only in this message, and the copy you can open here is unsaved and labelled partial.";
    default:
      // Only the live chat gets here: the server is still finishing the turn
      // and will record its answer on the part, which a reload then shows. A
      // Stop is acted on by the server up to a second after this page stops
      // receiving, so its saved copy can be LONGER than this one (live QA,
      // re-check 6: 97 characters here, 463 saved).
      return "What arrived here is kept in this message, and the server may have kept writing after this page stopped receiving. Reload the chat to see whether it was saved as a document and how long the saved copy is; until then, the copy you can open here is unsaved, labelled partial, and may be shorter than the saved one.";
  }
}

/**
 * WHICH KIND OF COPY A TAB IS SHOWING. Set only for the copy a tab rebuilds from
 * the message it was still receiving (a `PartialDocumentStore` of `unknown`), whose
 * length is what reached THIS page and not what the server holds. `stopped` is
 * this tab's own Stop (`metadata.streamStopped`); `died` is any other end of the
 * stream. A copy read back from a saved or marked part is exact and takes none.
 */
export type ClientCopy = "stopped" | "died";

function deadDetail(
  salvage: SalvagedTextDocument,
  toolType: string | undefined,
  store: PartialDocumentStore,
  stoppedHere: boolean
): string {
  if (!salvage.salvaged) {
    return `The model started ${whatWasBeingWritten(toolType)} and the stream carrying its input stopped before it finished, so the call never ran. ${salvage.why}`;
  }
  const chars = salvage.contentChars.toLocaleString("en-US");
  // The count is exact only when the server's own answer is known. In the live
  // chat (`unknown`) it is what had arrived on this page, so it says "at least".
  let opening = `The model started writing a document and the stream carrying it stopped after ${chars} characters.`;
  if (store.state === "unknown") {
    opening = stoppedHere
      ? `The model started writing a document and the reply was stopped after at least ${chars} characters had arrived here.`
      : `The model started writing a document and the stream carrying it stopped after at least ${chars} characters had arrived here.`;
  }
  return [
    opening,
    whereItWent(store),
    `It stops after: “${salvage.stoppedAfter}”`,
  ].join(" ");
}

function continueRequest(
  salvage: SalvagedTextDocument,
  toolType: string | undefined
): string {
  if (!salvage.salvaged) {
    return `The previous attempt at ${whatWasBeingWritten(toolType)} was cut off before anything usable arrived. Please do it again from the beginning.`;
  }
  const named = salvage.title ? ` of “${salvage.title}”` : "";
  return `Continue the document${named} from exactly where it stopped. The last line that arrived was: “${salvage.stoppedAfter}”. Resume from that point — do not restart and do not repeat what is already written.`;
}

/**
 * WHETHER NO MORE INPUT CAN ARRIVE FOR A TOOL PART IN THIS CHAT, FROM THE
 * RENDERER'S SIDE. It is the renderer's `streamEnded`.
 *
 * Five facts, none sufficient alone:
 *
 *  - Only the LAST message can be receiving a stream, so any earlier message
 *    has ended whatever the chat is doing. A chat-wide `submitted`/`streaming`
 *    is usually a continuation streaming in a NEW message; it says nothing
 *    about the dead one above it, and a stale `activeStreamId` on that dead
 *    message must not bring its spinner back.
 *  - `submitted`/`streaming` on the last message means it is arriving.
 *  - `error` on the last message means the request carrying it failed or was
 *    cut (a timeout, a dropped connection). The `finish` chunk that would have
 *    cleared `activeStreamId` never came, so the client's copy keeps the id it
 *    got at `start` and `activeStreamId` alone calls the part alive forever —
 *    a "Creating…" spinner beside a "Something went wrong" banner, until a
 *    reload.
 *  - `stopped` means this tab's own Stop cut the message's stream (an aborted
 *    request, noted by `ChatSync`'s `onFinish`). Like an `error`, it leaves the
 *    client's copy with the id it got at `start`, and the chat goes back to
 *    `ready`; without this fact the part spun on "Creating…" until a reload.
 *  - Otherwise the chat is `ready`, which is also how it looks for a beat on
 *    load while a resumable stream is being reattached. Only a message that is
 *    still waiting on a stream (`activeStreamId` set) may be called alive
 *    then; a null id is also what every message looks like in a read-only view,
 *    which is why it cannot decide on its own either.
 */
export function hasInputStreamEnded({
  isLastMessage,
  chatStatus,
  activeStreamId,
  stopped = false,
}: {
  isLastMessage: boolean;
  chatStatus: ChatStatus;
  activeStreamId: string | null | undefined;
  /** This tab's own Stop cut the message's stream (`metadata.streamStopped`). */
  stopped?: boolean;
}): boolean {
  if (!isLastMessage) {
    return true;
  }
  if (chatStatus === "submitted" || chatStatus === "streaming") {
    return false;
  }
  if (chatStatus === "error" || stopped) {
    return true;
  }
  return !activeStreamId;
}

/**
 * THE DETECTION HALF.
 *
 * `streamEnded` is the caller's fact, not this module's, because the two
 * callers know it differently: the route knows it because it is inside
 * `onFinish`, and the renderer asks `hasInputStreamEnded`. Both feed the same
 * judgement so the live chat and a reloaded page agree.
 *
 * `output-error` carrying the marker is recognised as the same failure so that
 * a page reloaded after the server marked the part renders the salvage card
 * rather than a bare red "Error:" line. Such a part also says whether a
 * document was written for it; an unmarked stranded part does not know.
 */
export function describeInputStream({
  state,
  streamEnded,
  input,
  errorText,
  toolType,
  saved,
  reloadMayAnswer = true,
  stoppedHere = false,
}: {
  state: string;
  streamEnded: boolean;
  input: unknown;
  errorText: string | null | undefined;
  /**
   * The part's `type`, e.g. `tool-createTextDocument`. Optional because the
   * document renderer only ever asks about document tools; the sweep passes it
   * so a dead non-document call is described as what it actually was.
   */
  toolType?: string;
  /**
   * The server's own answer, for the sweep: the document it wrote, or null
   * when it wrote none. Omitted by the renderer, which reads the answer back
   * from a marked part's `errorText` instead.
   */
  saved?: SavedPartialDocument | null;
  /**
   * Whether the server may still write its answer onto this part, so that a
   * reload could show something this render cannot. The renderer passes
   * whether the message still carries an `activeStreamId`: it does for a turn
   * that just died in this tab (the finish chunk that clears it never came),
   * and it does not for a part loaded from storage. An unmarked stranded part
   * loaded from storage was left that way by a turn whose server side is long
   * over and recorded nothing, which makes it `not-saved` rather than
   * `unknown`. Ignored when `saved` or a marker already answers.
   */
  reloadMayAnswer?: boolean;
  /**
   * This tab's own Stop cut the stream (`metadata.streamStopped`). Only the
   * wording of the live copy (`unknown`) uses it: a Stop is "stopped", not a
   * stream that failed.
   */
  stoppedHere?: boolean;
}): InputStreamVerdict {
  const markedDead =
    state === "output-error" &&
    (errorText ?? "").startsWith(DEAD_INPUT_STREAM_MARKER);
  const strandedMidStream = state === "input-streaming" && streamEnded;

  if (!(markedDead || strandedMidStream)) {
    return { died: false };
  }

  const salvage = salvageTextDocumentInput(input);
  const store = storeFor({
    salvage,
    saved,
    markedErrorText: markedDead ? errorText : null,
    reloadMayAnswer,
  });
  return {
    died: true,
    headline: HEADLINE,
    detail: deadDetail(salvage, toolType, store, stoppedHere),
    continueRequest: continueRequest(salvage, toolType),
    salvage,
    store,
  };
}

function storeFor({
  salvage,
  saved,
  markedErrorText,
  reloadMayAnswer,
}: {
  salvage: SalvagedTextDocument;
  saved: SavedPartialDocument | null | undefined;
  markedErrorText: string | null | undefined;
  reloadMayAnswer: boolean;
}): PartialDocumentStore {
  // Nothing salvaged means nothing could have been written, whatever a caller
  // or a stored string claims.
  if (!salvage.salvaged) {
    return { state: "not-saved" };
  }
  if (saved !== undefined) {
    return saved === null
      ? { state: "not-saved" }
      : { state: "saved", ...saved };
  }
  if (markedErrorText) {
    return readStoreFromErrorText(markedErrorText);
  }
  return reloadMayAnswer ? { state: "unknown" } : { state: "not-saved" };
}

/**
 * WHICH ACTION A DEAD CARD OFFERS TO CARRY ON.
 *
 * "Continue from where it stopped" sends the last line THIS page received. That
 * is the document's real end only when the server's own copy is the one on the
 * card (`saved`, or `not-saved` from its marker or a stored part). While the
 * server's answer is unknown (`unknown`) the saved document can be LONGER than
 * this page's copy (97 characters here, 463 saved, live QA re-check 6), and a
 * continuation from the shorter copy repeats what the server already kept. So
 * the live card sends the founder to the server's answer first (a page reload),
 * and the card that answer produces offers Continue from the exact saved text.
 */
export function continueAction(
  store: PartialDocumentStore
): "continue" | "reload-first" {
  return store.state === "unknown" ? "reload-first" : "continue";
}

const PARTIAL_PREFIX = "[PARTIAL — stream died]";

/** The prefix of a copy of a turn the founder stopped, live or stored: nothing died. */
const PARTIAL_PREFIX_STOPPED = "[PARTIAL — stopped]";

/**
 * The title a salvaged document is stored under.
 *
 * The prefix leads, so every place a title appears unadorned — the artifact
 * header, the document list, a share link — carries the warning without any of
 * them having to know this feature exists. It says "stopped" for a turn the
 * founder cut with Stop, because "stream died" is false of it: a live copy cut by
 * this tab's own Stop (`copy`, see `ClientCopy`), and the stored copy of a turn
 * the route knows the founder stopped (`stoppedByUser`). Every other title,
 * stored or live, keeps "stream died": a real death, and the request deadline.
 */
export function partialDocumentTitle(
  title: string | null,
  copy?: ClientCopy,
  stoppedByUser = false
): string {
  const prefix =
    copy === "stopped" || stoppedByUser
      ? PARTIAL_PREFIX_STOPPED
      : PARTIAL_PREFIX;
  return `${prefix} ${title ?? "Untitled document"}`;
}

/**
 * The body a salvaged document is stored with.
 *
 * BANNERED AT BOTH ENDS, DELIBERATELY. A reader who opens the document sees the
 * warning; a reader who scrolls to the bottom looking for a conclusion finds
 * out why there isn't one, at the exact character where the stream stopped.
 * Marking only the top would leave the far more common failure — reading to the
 * end and believing it ended — completely unguarded.
 *
 * A LIVE COPY (`copy`, see `ClientCopy`) is the one a tab rebuilds from the
 * message it was still receiving, and it says only what is true of it: this is
 * what reached THIS page, and the saved document may be longer. "Nothing further
 * was ever written" is true of a copy the server wrote and false of this one (a
 * Stop showed 97 characters here beside 463 saved, live QA re-check 6). Every
 * stored copy keeps the exact wording.
 *
 * THE BODY AGREES WITH THE TITLE (`partialDocumentTitle`) about who ended the
 * stream. A turn the founder cut with Stop says "the reply was stopped" in both:
 * a stored copy is told by the route (`stoppedByUser`), a live copy knows it from
 * `copy`. A stored copy is exact either way: "Nothing further was ever written"
 * is true of what the server wrote.
 */
export function partialDocumentBody(
  salvage: Extract<SalvagedTextDocument, { salvaged: true }>,
  copy?: ClientCopy,
  stoppedByUser = false
): string {
  const chars = salvage.contentChars.toLocaleString("en-US");
  const stopped = stoppedByUser || copy === "stopped";
  // Headings and paragraphs only. The text artifact opens in Lexical, whose
  // default markdown import cannot put a heading inside a quote, does not
  // treat a bare ">" line as a quote, and has no horizontal-rule node — so a
  // blockquoted banner showed up as raw "> ##" and "---" characters there.
  const banner = [
    "## ⚠️ PARTIAL DOCUMENT — RECOVERED, NOT COMPLETE",
    "",
    copy
      ? `${stopped ? "The reply was stopped" : "The stream writing this document stopped"} after at least ${chars} characters had reached this page. Everything below arrived here; the saved document may be longer, so reload the chat to see it. The last line is very likely cut mid-sentence.`
      : `${stopped ? "The reply was stopped" : "The stream writing this document stopped"} after ${chars} characters. Everything below arrived; nothing after it ever did, and the last line is very likely cut mid-sentence.`,
    "",
    // A live copy may be shorter than the saved document, so continuing from ITS
    // last line would repeat what the server already kept: reload first.
    copy
      ? "This text was salvaged so it would not be lost. **Do not treat it as a finished document.** Reload the chat first, then ask the assistant to continue from the saved document."
      : "This text was salvaged so it would not be lost. **Do not treat it as a finished document.** Ask the assistant to continue from the last line to complete it.",
  ].join("\n");

  const footer = copy
    ? [
        "## ⚠️ THIS COPY STOPS HERE",
        "",
        `What reached this page ends at this point, ${chars} characters in. The saved document may be longer: reload the chat to see it.`,
      ]
    : [
        "## ⚠️ THE DOCUMENT STOPS HERE",
        "",
        `${stopped ? "The reply was stopped" : "The stream was cut"} at this point, ${chars} characters in. Nothing further was ever written. The line above is where a continuation must resume.`,
      ];

  return `${banner}\n\n${salvage.content}\n\n${footer.join("\n")}\n`;
}

/**
 * The minimum a message part must look like for this module to judge it.
 *
 * Deliberately structural rather than the SDK's `ToolUIPart`: this file is pure
 * and is imported by the route, by the renderer, and by its own tests, and none
 * of them should have to construct a full SDK union to ask "did this die?".
 */
type PartLike = {
  readonly type: string;
  readonly state?: unknown;
  readonly input?: unknown;
  readonly toolCallId?: unknown;
};

/** One dead call, with everything a caller needs to act on it. */
export type DeadInputStreamRecord = {
  readonly toolType: string;
  readonly toolCallId: string;
  readonly verdict: Extract<InputStreamVerdict, { died: true }>;
};

export type DeadStreamSweep<P> = {
  /**
   * The parts to persist. Every dead tool part has been rewritten to
   * `output-error` carrying DEAD_INPUT_STREAM_MARKER — WITH ITS `input` INTACT,
   * because that field is the only copy of what arrived. The array is the
   * caller's own reference when nothing died, so an untouched message is
   * provably untouched.
   */
  readonly parts: readonly P[];
  readonly deaths: readonly DeadInputStreamRecord[];
  /**
   * The markdown to append as a text part, or NULL when nothing died.
   *
   * Not `""`. An empty announcement is exactly the thing that went wrong on
   * 2026-08-21 — a turn that produced zero characters and left the founder to
   * work out why — so "nothing to say" and "say nothing" must not be the same
   * value.
   */
  readonly announcement: string | null;
};

function deadVerdictFor(
  part: PartLike,
  saved: SavedPartialDocument | null
): InputStreamVerdict {
  const isToolPart =
    part.type.startsWith("tool-") && typeof part.toolCallId === "string";
  if (!isToolPart) {
    return { died: false };
  }
  return describeInputStream({
    state: typeof part.state === "string" ? part.state : "",
    streamEnded: true,
    input: part.input,
    errorText: null,
    toolType: part.type,
    saved,
  });
}

/** A dead call before anything has been written for it. */
export type DeadInputStream = {
  readonly toolType: string;
  readonly toolCallId: string;
  readonly salvage: SalvagedTextDocument;
};

/**
 * THE FIRST HALF OF THE ROUTE'S RESCUE: WHICH CALLS DIED, AND WHAT SURVIVED.
 *
 * Kept apart from `sweepDeadInputStreams` because the sentence the sweep
 * writes says whether a document was saved, and that is only known after the
 * route has tried to save one from this list.
 */
export function findDeadInputStreams(
  parts: readonly PartLike[]
): DeadInputStream[] {
  const found: DeadInputStream[] = [];
  for (const part of parts) {
    const verdict = deadVerdictFor(part, null);
    if (verdict.died) {
      found.push({
        toolType: part.type,
        toolCallId: part.toolCallId as string,
        salvage: verdict.salvage,
      });
    }
  }
  return found;
}

function errorTextFor(
  verdict: Extract<InputStreamVerdict, { died: true }>
): string {
  const { store } = verdict;
  const tag =
    store.state === "saved"
      ? ` [partial-document:${store.kind}:${store.documentId}${store.stoppedByUser ? ":stopped" : ""}]`
      : "";
  return `${DEAD_INPUT_STREAM_MARKER}${tag} ${verdict.detail}`;
}

/**
 * FIND EVERY TOOL CALL THAT DIED MID-INPUT AND MAKE IT LOOK LIKE ONE.
 *
 * Called from the route inside `onFinish`, which is the only moment that knows
 * the stream is over — before that point `input-streaming` is a legitimate,
 * temporary state and marking it would be the opposite lie.
 *
 * `saved` maps a dead call's `toolCallId` to the document the route wrote for
 * it. A call missing from it was not saved, and its part and announcement say
 * so; the saved document's id and kind are stamped on its part so the card can
 * open that row after a reload.
 */
export function sweepDeadInputStreams<P extends PartLike>(
  parts: readonly P[],
  saved: ReadonlyMap<string, SavedPartialDocument> = new Map()
): DeadStreamSweep<P> {
  const deaths: DeadInputStreamRecord[] = [];
  const rewritten: P[] = [];

  for (const part of parts) {
    const verdict = deadVerdictFor(
      part,
      typeof part.toolCallId === "string"
        ? (saved.get(part.toolCallId) ?? null)
        : null
    );

    if (!verdict.died) {
      rewritten.push(part);
      continue;
    }

    deaths.push({
      toolType: part.type,
      toolCallId: part.toolCallId as string,
      verdict,
    });
    rewritten.push({
      ...part,
      state: "output-error",
      errorText: errorTextFor(verdict),
    });
  }

  if (deaths.length === 0) {
    return { parts, deaths, announcement: null };
  }

  const announcement = deaths
    .map((death) =>
      [
        ANNOUNCEMENT_LEAD,
        death.verdict.detail,
        `To finish it, ask: *${death.verdict.continueRequest}*`,
      ].join("\n\n")
    )
    .join("\n\n---\n\n");

  return { parts: rewritten, deaths, announcement };
}
