const MAX_IDEA_NAME_LENGTH = 48;
const FALLBACK_IDEA_NAME = "New idea";
const FIRST_SENTENCE = /^(.+?[.!?])(?:\s|$)/;
// "I want to build an app that…" names every project the same way. The verb
// phrase carries nothing; what follows it is the idea.
const LEADING_FILLER =
  /^(?:i(?:\s+(?:want|plan|would\s+like|am\s+going)|'d\s+like)\s+to\s+(?:build|make|create|launch|start)|i(?:'m|\s+am)\s+(?:building|making|creating)|(?:my\s+)?idea\s*(?:is|:))\s*/i;
const TRAILING_PUNCTUATION = /[\s.,;:!?-]+$/;

/**
 * A short project name for an idea, from the founder's own first words. The
 * founder can rename the project later, so this only has to be recognisable
 * in the sidebar, never right. Never empty: `project.create` requires a name.
 */
export function deriveIdeaName(description: string): string {
  const firstLine =
    description
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  const firstSentence = firstLine.match(FIRST_SENTENCE)?.[1] ?? firstLine;
  const core = firstSentence
    .replace(LEADING_FILLER, "")
    .replace(TRAILING_PUNCTUATION, "")
    .trim();

  if (!core) {
    return FALLBACK_IDEA_NAME;
  }

  const capitalised = core.charAt(0).toUpperCase() + core.slice(1);
  if (capitalised.length <= MAX_IDEA_NAME_LENGTH) {
    return capitalised;
  }

  const cut = capitalised.slice(0, MAX_IDEA_NAME_LENGTH);
  const lastSpace = cut.lastIndexOf(" ");
  // Break at a word unless that throws away most of the name.
  const wordSafe =
    lastSpace > MAX_IDEA_NAME_LENGTH / 2 ? cut.slice(0, lastSpace) : cut;
  return `${wordSafe.replace(TRAILING_PUNCTUATION, "")}…`;
}
