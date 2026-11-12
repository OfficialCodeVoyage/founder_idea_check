import type {
  LaneOutcome,
  LaneReport,
  ResearchUpdate,
  SearchResultItem,
} from "@/tools/platform/research-updates-schema";

/**
 * THE RESEARCH SUMMARY ROW, AS DATA — AND THE ARM THAT CARRIES NO COUNT.
 *
 * On 2026-08-21 a founder asked for a source-cited study with primary sources
 * and got this row, twice:
 *
 *     Researched for 0 seconds, 0 searches, 0 sources
 *     Error: Deep research failed with error: Invalid prompt: messages must not be empty
 *
 * Every number in it was invented. `deepResearch` never received a prompt, the
 * pipeline threw before `runSupervisor`, and no search was ever attempted — but
 * three zeros render as a search that ran, took no time, and found nobody. That
 * is the strongest possible statement of "there is no demand for your idea",
 * delivered by a tool that did not look.
 *
 * This is the SIXTH instance of the same bug class here, after `context_window:
 * 0` (utils.ts), `pricing: {}`, the empty reaction list, and `perCriterion: []`
 * twice (lib/phases/attempt-history.ts). Every previous fix took the same shape
 * and so does this one: THE NOT-RUN STATE GETS ITS OWN ARM, AND THAT ARM HOLDS
 * NO READABLE COUNT. Not `0`, not `null` waiting to be `?? 0`-ed at a call site,
 * not an empty array that a `.length` turns back into a zero. There must be
 * nothing on it for a renderer to print as a number.
 *
 * WHAT IS *NOT* THIS BUG: a search that ran and returned nothing. `sources: 0`
 * on the `searched: true` arm is TRUE and load-bearing — apps/research/README.md
 * calls this the sidecar's one thing not to break, because "we looked and the
 * topic genuinely has no coverage" is a finding the *Verifying Demand* gate acts
 * on. The two states must be told apart, not merged into whichever is safer.
 */
export type ResearchRunView =
  | {
      searched: false;
      /**
       * Why there is nothing to count. Never blank — the row this replaces was
       * illegible precisely because it said something confident and wrong.
       */
      note: string;
    }
  | {
      searched: true;
      /** Searches actually issued. At least 1 on this arm, by construction. */
      searches: number;
      /** Sources returned. MAY BE 0, and a 0 here is a real finding. */
      sources: number;
      /**
       * Wall-clock duration, or an admission that it was not recorded.
       *
       * Its own union for the same reason as everything above. The previous
       * arithmetic read `progressUpdates[0].timestamp` and subtracted it from
       * the completion timestamp — so a run whose only marker was the terminal
       * one computed `completed - completed` and reported a confident
       * "0 seconds". A run with no start marker has no duration to report.
       */
      elapsed: { known: true; seconds: number } | { known: false };
    };

const NEVER_SEARCHED =
  "deep research ended before any search was attempted, so there is nothing to count";

const ALL_SKIPPED =
  "every planned search was skipped before any request was made, so there is nothing to count";

/**
 * PURE. Reads the update stream the tool emitted and says what actually ran.
 *
 * The discriminant is the presence of a `web` update, not a count derived from
 * one: `web` updates are written by the search tool itself, at the moment it is
 * called, so zero of them means the search tool was never reached.
 *
 * A `skipped` web update is the search tool refusing a step before any request
 * (the search time had run out, or the call carried no usable query; the reason
 * is in the update's title). It is in the stream so the founder can see the
 * step was refused, but it is NOT a search: counting it printed "8 searches"
 * for a run in which three never ran. A run whose every step was skipped has
 * nothing to count, and says so on the `searched: false` arm.
 */
export function describeResearchRun(
  updates: readonly ResearchUpdate[]
): ResearchRunView {
  const allWebUpdates = updates.filter((update) => update.type === "web");
  if (allWebUpdates.length === 0) {
    return { searched: false, note: NEVER_SEARCHED };
  }
  const webUpdates = allWebUpdates.filter(
    (update) => update.status !== "skipped"
  );
  if (webUpdates.length === 0) {
    return { searched: false, note: ALL_SKIPPED };
  }

  return {
    searched: true,
    searches: webUpdates.length,
    sources: uniqueSources(webUpdates).length,
    elapsed: measureElapsed(updates),
  };
}

/**
 * EVERY SOURCE A RUN FOUND, ONE ENTRY PER URL, first occurrence first.
 *
 * Two readers need the same list and used to compute it differently. The run
 * header ("Researched for 95 seconds, 6 searches, 100 sources") summed the
 * result lists of every search step, so a page two steps both returned counted
 * twice; the Sources chip next to it (`SourcesAnnotations`) listed each url
 * once and said 96. One permalink is one source, and the same page counted
 * twice reads as two pieces of evidence, so both now read it from here.
 *
 * `toSearchResults` in tools/platform/deep-research/sidecar-search.ts already
 * dedupes inside one step; this is the second dedupe, where the steps (and the
 * parallel researchers) meet. A step that was skipped carries no results and
 * contributes nothing.
 */
export function uniqueSources(
  updates: readonly ResearchUpdate[]
): SearchResultItem[] {
  const byUrl = new Map<string, SearchResultItem>();
  for (const update of updates) {
    if (update.type !== "web") {
      continue;
    }
    for (const result of update.results ?? []) {
      if (!byUrl.has(result.url)) {
        byUrl.set(result.url, result);
      }
    }
  }
  return [...byUrl.values()];
}

/**
 * BOTH MARKERS OR NOTHING. A duration needs two ends; guessing the missing one
 * is how the old row produced its "0 seconds".
 */
function measureElapsed(
  updates: readonly ResearchUpdate[]
): Extract<ResearchRunView, { searched: true }>["elapsed"] {
  const started = updates.find((update) => update.type === "started");
  const completed = updates.find((update) => update.type === "completed");
  if (!(started && completed)) {
    return { known: false };
  }
  const seconds = Math.floor((completed.timestamp - started.timestamp) / 1000);
  if (seconds < 0) {
    return { known: false };
  }
  return { known: true, seconds };
}

/**
 * Both forms are spelled out at every call site. Appending "s" printed
 * "5 searchs" on every run summary; English plurals are not a suffix rule, so
 * the caller names the word it means rather than this function guessing.
 */
function plural(count: number, forms: { one: string; other: string }): string {
  return `${count} ${count === 1 ? forms.one : forms.other}`;
}

const SEARCH = { one: "search", other: "searches" };
const SOURCE = { one: "source", other: "sources" };
const SECOND = { one: "second", other: "seconds" };

/** PURE. The row's text. Kept next to the union so the arms cannot drift apart. */
export function researchRunLine(view: ResearchRunView): string {
  if (!view.searched) {
    return `No search ran — ${view.note}`;
  }
  const counts = `${plural(view.searches, SEARCH)}, ${plural(view.sources, SOURCE)}`;
  if (view.elapsed.known) {
    return `Researched for ${plural(view.elapsed.seconds, SECOND)}, ${counts}`;
  }
  return `Researched ${counts} (elapsed time not recorded)`;
}

/**
 * WHICH LANES RAN, ACROSS A WHOLE RESEARCH RUN.
 *
 * `sidecarWebSearch` writes one lane report per search step, so a run with three
 * steps streams three observations of the same lanes. Merging them here
 * rather than in the producer is deliberate: the producer knows what happened in
 * ONE harvest, and flattening at that point would have to choose between
 * reporting the last step and reporting the best, both of which lose something.
 *
 * PRECEDENCE, most-informative first, and the order is the whole argument:
 *
 * 1. `returned`      it demonstrably worked at least once. Counts sum.
 * 2. `refused`       it was blocked or gated. The LAST reason wins, because a
 *                    later step is a later observation. Never summarised.
 * 3. `found-nothing` it ran and the topic has no coverage there. A finding.
 * 4. `not-attempted` nothing ever asked it.
 *
 * A lane never seen at all does not appear. Invented "not attempted" rows
 * would be a claim about a gate decision nobody made.
 */
export function mergeLaneReports(
  updates: readonly ResearchUpdate[]
): LaneReport[] {
  const byId = new Map<string, LaneReport>();
  for (const update of updates) {
    if (update.type !== "lanes") {
      continue;
    }
    for (const lane of update.lanes) {
      const existing = byId.get(lane.sourceId);
      byId.set(
        lane.sourceId,
        existing
          ? { ...lane, outcome: mergeOutcome(existing.outcome, lane.outcome) }
          : lane
      );
    }
  }
  return [...byId.values()];
}

const OUTCOME_RANK: Record<LaneOutcome["kind"], number> = {
  returned: 3,
  refused: 2,
  "found-nothing": 1,
  "not-attempted": 0,
};

function mergeOutcome(earlier: LaneOutcome, later: LaneOutcome): LaneOutcome {
  if (earlier.kind === "returned" && later.kind === "returned") {
    // Kept and left-out counts both sum across steps; the later reason is the
    // current one (the audience is read once per run, so it rarely differs).
    const leftOut =
      earlier.leftOut || later.leftOut
        ? {
            count: (earlier.leftOut?.count ?? 0) + (later.leftOut?.count ?? 0),
            because: (later.leftOut ?? earlier.leftOut)?.because ?? "",
          }
        : undefined;
    return {
      kind: "returned",
      signals: earlier.signals + later.signals,
      ...(leftOut ? { leftOut } : {}),
    };
  }
  // Ties go to the later observation, so a refusal reason stays current.
  return OUTCOME_RANK[later.kind] >= OUTCOME_RANK[earlier.kind]
    ? later
    : earlier;
}
