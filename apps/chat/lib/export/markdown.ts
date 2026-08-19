/**
 * ─────────────────────────────────────────────────────────────────────────────
 * RENDERING MODEL-WRITTEN TEXT INTO A DOCUMENT WITHOUT LETTING IT REWRITE THE
 * DOCUMENT.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Fact values are produced by an extraction model and stored as free text. They
 * are then pasted into Markdown that a human reads and a coding agent obeys.
 * Three concrete failure modes, none of them theoretical:
 *
 *  1. STRUCTURE INJECTION. A value containing "\n## Requirements" grows a
 *     top-level section that the PRD never authorised, and it will render as if
 *     the generator wrote it. Every value is therefore emitted inside a
 *     blockquote, where `> ` on EVERY line makes headings, lists and rules
 *     inert.
 *
 *  2. FENCE BREAKOUT. A value containing ``` inside a fenced block terminates
 *     the fence and everything after it escapes into the document body.
 *     fenceFor() sizes the fence to one backtick longer than the longest run in
 *     the content, which is exactly the CommonMark rule.
 *
 *  3. TABLE CORRUPTION. An unescaped `|` adds a column; a newline ends the row.
 *     tableCell() escapes the first and flattens the second.
 *
 * A fourth, quieter one: CRLF. Values arriving from a Windows client carry
 * `\r\n`, and a `\r` left inside a blockquote line renders as a stray control
 * character in some viewers and breaks byte-identical output between platforms.
 * Everything is normalised to `\n` on the way in.
 *
 * PURE. No I/O, no clock, no randomness.
 */

const CRLF = /\r\n?/g;
/**
 * Control characters to strip. `\t` (09) and `\n` (0a) are deliberately NOT in
 * the range — they are legitimate in prose. `\r` (0d) is not either, because
 * CRLF normalisation has already turned every carriage return into a newline.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters IS the rule here — the lint catches them appearing by accident, and they are the subject of this expression.
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;
const WHITESPACE_RUN = /\s+/g;
const PIPE = /\|/g;
const BACKTICK_RUN = /`+/g;
const TRAILING_BLANK_LINES = /\n{3,}/g;

/**
 * PURE. The first thing every untrusted string passes through.
 *
 * Strips control characters (keeping `\n` and `\t`, which are legitimate in
 * prose) and normalises line endings. Deliberately does NOT trim or truncate:
 * losing the end of a founder's fact to a cosmetic rule would be a silent data
 * loss in the one document they are meant to trust.
 */
export function normalizeText(raw: string): string {
  return raw.replace(CRLF, "\n").replace(CONTROL_CHARS, "");
}

/** PURE. Collapse to a single line — for headings, table cells, list items. */
export function singleLine(raw: string): string {
  return normalizeText(raw).replace(WHITESPACE_RUN, " ").trim();
}

/**
 * PURE. Escape a value for a Markdown table cell.
 *
 * `|` becomes `\|` and every newline is collapsed, because a raw newline ends
 * the row and the remaining text becomes a malformed row that GitHub silently
 * drops — the value would simply disappear from the document.
 */
export function tableCell(raw: string): string {
  return singleLine(raw).replace(PIPE, "\\|");
}

/**
 * PURE. Wrap untrusted multi-line text as a blockquote.
 *
 * Every line gets `> `, INCLUDING blank ones, so the quote is a single
 * contiguous block. A blank unprefixed line would terminate the quote and let
 * the remainder of the value render as document-level Markdown, which is the
 * structure-injection hole this function exists to close.
 */
export function blockquote(raw: string): string {
  const text = normalizeText(raw).trimEnd();
  if (text.length === 0) {
    return "> _(empty)_";
  }
  return text
    .split("\n")
    .map((line) => (line.length === 0 ? ">" : `> ${line}`))
    .join("\n");
}

/**
 * PURE. The shortest fence that cannot be closed by `content`.
 *
 * CommonMark closes a fenced block on the first run of backticks at least as
 * long as the opener, so the opener must be strictly longer than anything
 * inside. Minimum three.
 */
export function fenceFor(content: string): string {
  let longest = 0;
  for (const match of content.matchAll(BACKTICK_RUN)) {
    longest = Math.max(longest, match[0].length);
  }
  return "`".repeat(Math.max(3, longest + 1));
}

/** PURE. A fenced code block that the content provably cannot escape. */
export function codeBlock(content: string, language = ""): string {
  const body = normalizeText(content).trimEnd();
  const fence = fenceFor(body);
  return `${fence}${language}\n${body}\n${fence}`;
}

/**
 * PURE. Join document sections, dropping empty ones and collapsing runs of
 * blank lines, so a section that renders to nothing leaves no hole behind.
 *
 * Always ends with exactly one trailing newline: POSIX text files end in one,
 * git complains about the absence, and "exactly one" keeps the output
 * byte-stable across regenerations.
 */
export function joinSections(sections: readonly string[]): string {
  const body = sections
    .map((section) => section.trimEnd())
    .filter((section) => section.length > 0)
    .join("\n\n")
    .replace(TRAILING_BLANK_LINES, "\n\n");
  return `${body}\n`;
}

/** PURE. A markdown bullet list, or an explicit empty marker. */
export function bulletList(
  items: readonly string[],
  emptyMarker = "_(none)_"
): string {
  if (items.length === 0) {
    return emptyMarker;
  }
  return items.map((item) => `- ${singleLine(item)}`).join("\n");
}
