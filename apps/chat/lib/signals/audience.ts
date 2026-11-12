import type { DemandSignal, ProviderDescriptor, SignalSourceId } from "./types";

/**
 * WHICH SOURCE MATTERS FOR *THIS* BUYER — and the one place that decides it.
 *
 * Take a founder whose buyer is parents of 3-8 year olds, validating a
 * bedtime-routine app. A research report for that founder that leads with
 * Hacker News is answering in the wrong room: those parents talk on Reddit and
 * across the general web, and Hacker News is a developer forum.
 *
 * Nothing set that ordering on purpose. `ALL_PROVIDERS` is a flat list,
 * `selectEnabledProviders` preserves its order, and `harvestSignals`
 * concatenates in that order, so Hacker News led every report for every project
 * because it is written first in a registry — and led most visibly when the
 * other lanes were switched off, leaving it the only lane still answering.
 * There was never any notion of an AUDIENCE at all. That is an accident, not a
 * ranking, and it survived because nobody had to defend it.
 *
 * WHY THE DECISION IS HERE AND NOT IN THE SIDECAR. The spec asks for the
 * ranking to be made explicitly rather than left to enablement order, so this
 * is where it is made and this comment is the record of why here.
 * `apps/research` scores and fuses — `app/pipeline/fusion.py` even takes a
 * `source_weights` map — but `POST /v1/signals/{source_id}` runs exactly ONE
 * source per request. Its plan is built with `source_weights={id: 1.0}`, and a
 * single scalar over a single stream cannot reorder anything: weighted RRF
 * multiplies every item in that stream by the same number. Cross-lane ordering
 * only exists at the point where several lanes' results meet, and in this
 * system that point is `runSignalHarvest` -> `sidecarWebSearch`, on this side of
 * the wire. Putting a segment weight in Python would have looked like a
 * ranking and changed nothing. (The multi-source `/v1/fuse` path the sidecar's
 * main.py mentions — `apps/chat/lib/research/loop.ts` — does not exist.)
 *
 * TWO THINGS THIS MODULE DECIDES, because they are one decision:
 *   1. the per-lane weight, applied to the relevance the sidecar already
 *      computed, so the lanes a buyer actually reads lead the report; and
 *   2. WHICH SUBREDDITS the Arctic Shift lane is asked about — without them
 *      that adapter refuses every request, by design, because Reddit's archive
 *      cannot keyword-search all of Reddit. Choosing subreddits for a project
 *      IS the segment question, so it is answered next to the weights.
 *
 * NOTHING IS EVER DROPPED. A weight is a multiplier on the sidecar's own
 * relevance and never reaches zero, so a Hacker News thread that is genuinely
 * four times more relevant than the Reddit alternative still leads. Every lane
 * still runs, and every lane still appears in the per-lane report
 * (`describeLanes`) whatever its weight. Deprioritised is not disabled.
 */

// ─────────────────────────────────────────────────────────────────────────────
// (a) WHO THE BUYER IS.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The only distinction that changes the ordering: does the buyer's own working
 * day involve building software?
 *
 * Deliberately two arms and not a taxonomy of verticals. The question is about
 * Hacker News, and Hacker News is a developer forum — a finer-grained
 * segment model would invent confidence about markets nobody here has measured.
 * The subreddit table below is where vertical detail belongs, because there a
 * wrong entry produces a visible, named refusal instead of a silent reordering.
 */
export type BuyerAudience = "technical" | "non-technical";

/**
 * WHAT WE KNOW ABOUT THE BUYER — and the arm that knows nothing.
 *
 * THE UNKNOWN ARM CARRIES NO READABLE VALUE: no audience, no segment string, no
 * weight sitting at 0 waiting to be read as "ranks lowest". Six bugs in this
 * codebase were all a zero standing in for an unknown — `context_window: 0`,
 * `pricing: {}`, the empty reaction list, `perCriterion: []` twice, and the
 * "0 searches, 0 sources" row. Same shape here: a project whose buyer has not
 * been established must not be describable as having one. `rankSourcesFor`
 * answers this arm with `NEUTRAL_RANKING`, which is a NAMED ordering with its
 * own written justification — never a default that silently equals the
 * developer ordering, which is exactly the accident this file removes.
 */
export type AudienceView =
  | {
      known: true;
      audience: BuyerAudience;
      /** The buyer, in the words the project actually recorded. */
      segment: string;
      /** The phrases that decided it, so a wrong reading is arguable. */
      evidence: string;
    }
  | {
      known: false;
      reason: "no-segment-stated" | "conflicting-signals";
    };

/**
 * Roles whose working day is building software. These are the people Hacker
 * News and GitHub are actually about.
 *
 * "founder" IS DELIBERATELY ABSENT. Every user of this product is a founder, so
 * the word carries no information about their BUYER — and reading it as
 * technical would restore the Hacker-News-first default for the whole app under
 * a different name. "technical co-founder" is present because that phrase names
 * somebody else, which is what makes it a segment.
 *
 * Bare "api", "sdk" and "cli" are absent for the same reason in reverse: they
 * appear in ordinary product talk about this app itself, and a marker that
 * fires on the assistant's own vocabulary is measuring the wrong conversation.
 */
const TECHNICAL_MARKERS: readonly RegExp[] = [
  /\bdevelopers?\b/i,
  /\bdevs\b/i,
  /\bengineers?\b/i,
  /\bprogrammers?\b/i,
  /\bcoders?\b/i,
  /\bsysadmins?\b/i,
  /\bdev-?ops\b/i,
  /\bsres?\b/i,
  /\bsite reliability\b/i,
  /\bdata scientists?\b/i,
  /\bml engineers?\b/i,
  /\bctos?\b/i,
  /\btechnical co-?founders?\b/i,
  /\b(software|engineering|platform) teams?\b/i,
  /\bkubernetes\b/i,
  /\bterraform\b/i,
  /\bopen-?source maintainers?\b/i,
];

/**
 * Buyers whose working day is anything else. Not an exhaustive census — it is
 * the set of people-nouns a founder actually writes when naming a segment, and
 * a miss here costs a neutral ordering rather than a wrong one.
 *
 * AUDIENCE PHRASES, NOT COMMON WORDS. A bare word that technical talk uses for
 * something else is only a marker with the qualifier that makes it a person:
 * "drivers" alone is device drivers, "readers" alone is screen and RSS readers,
 * "tenants" is multi-tenancy, "child" is a child process, "students" may be CS
 * students, "coaches" is a verb. "customers at" named nobody, so it is gone.
 */
const NON_TECHNICAL_MARKERS: readonly RegExp[] = [
  /\bparents?\b/i,
  /\b(mums?|moms?|mothers?|dads?|fathers?)\b/i,
  /\b(kids|children|toddlers?|babies|infants?)\b/i,
  /\b(preschool|kindergarten|nursery)\w*\b/i,
  /\b(teachers?|educators?|tutors?)\b/i,
  /\b(school|high[- ]school|college|university|nursing|medical|law) students?\b/i,
  /\b(nurses?|doctors?|patients?|therapists?|carers?|caregivers?)\b/i,
  /\bsmall[- ]business(es)?\b/i,
  /\b(shop|store|salon|restaurant|cafe|bakery)\s?owners?\b/i,
  /\b(restaurants?|salons?|bakeries|cafes?)\b/i,
  /\b(bookkeepers?|accountants?|bartenders?|baristas?|chefs?)\b/i,
  /\b(homeowners?|landlords?|renters?|retirees?)\b/i,
  /\b(shoppers?|diners?|commuters?|travellers?|travelers?)\b/i,
  /\bpet (owners?|parents?|sitters?)\b/i,
  /\b(dog|cat) (walkers?|owners?|sitters?|groomers?)\b/i,
  /\b(gardeners?|plumbers?|electricians?|farmers?|house ?cleaners?)\b/i,
  /\b(delivery|truck|taxi|rideshare|uber|lyft|bus|van) drivers?\b/i,
  /\b(sports|fitness|football|soccer|basketball|tennis|swim|running|life) coach(es)?\b/i,
  /\b(athletes?|musicians?)\b/i,
  /\b(young|reluctant|early|beginning|struggling|avid|book) readers?\b/i,
];

/**
 * A FOUNDER DESCRIBING THEMSELVES IS NOT THE BUYER THEY NAMED.
 *
 * "I'm a software engineer building a bedtime app for parents of toddlers"
 * carries a technical marker ("engineer") and a non-technical one ("parents"),
 * and reading both as the buyer cancelled the buyer: `conflicting-signals`, the
 * neutral ranking, no subreddits, and a Reddit lane that refused every search
 * for exactly the consumer buyer it exists for. The founder's own job says who
 * is typing, and the buyer is whoever they went on to name.
 *
 * A self-description is a first-person introduction ("I'm a", "I am a", "I was
 * a", "we're a", "as a") followed by at most three filler words and then a
 * marker: "I'm a software engineer", "as a former ML engineer", "we're a small
 * team of engineers". The filler cannot run through a word that opens the next
 * clause (`CLAUSE_OPENERS`), so "I'm a founder building for developers" does not
 * read "developers" as the founder's own job. An article is required, because
 * "I'm building tools for developers" is the buyer, not a self-description.
 *
 * Only the markers inside these phrases are set aside, and only while the rest of
 * the text names a buyer: see `readAudience` for the fallback when it does not.
 */
const SELF_INTRO = String.raw`\b(?:i['’]m|i am|i was|i used to be|i['’]ve been|we['’]re|we are|as)\s+(?:an?|the)\s+`;
const CLAUSE_OPENERS =
  "(?:for|to|building|making|creating|designing|launching|selling|who|that|which|with|and|but|at|in|on|from|because|so)";
const SELF_FILLER = String.raw`(?:(?!${CLAUSE_OPENERS}\b)[\w'’./+#-]+\s+){0,3}?`;

/**
 * One pattern per marker, built from the markers themselves so the two lists
 * cannot drift apart: a role added to `TECHNICAL_MARKERS` is a self-description
 * too, with no second list to forget.
 */
const SELF_DESCRIPTIONS: readonly RegExp[] = [
  ...TECHNICAL_MARKERS,
  ...NON_TECHNICAL_MARKERS,
].map(
  (marker) =>
    new RegExp(`${SELF_INTRO}${SELF_FILLER}(?:${marker.source})`, "gi")
);

/** PURE. The text with every self-description removed, whitespace collapsed. */
function withoutSelfDescriptions(text: string): string {
  let rest = text;
  for (const pattern of SELF_DESCRIPTIONS) {
    rest = rest.replace(pattern, " ");
  }
  return rest.replace(/\s+/g, " ").trim();
}

function matched(text: string, markers: readonly RegExp[]): string[] {
  const hits: string[] = [];
  for (const marker of markers) {
    const found = text.match(marker);
    if (found && !hits.includes(found[0].toLowerCase())) {
      hits.push(found[0].toLowerCase());
    }
  }
  return hits;
}

/**
 * PURE. Reads the buyer out of whatever the caller could actually reach.
 *
 * THE AUTHORITATIVE SOURCE IS `targetUserFact` — the phase-1 project fact "a
 * specific buyer or user segment is named — a role and a context", stored on
 * `ProjectFact` and read by `getProjectFacts`. The live store holds exactly the
 * sentences this function has to cope with: "a reluctant 5-7-year-old whose
 * parent enforces the bedtime routine", "an in-house bookkeeper or controller
 * at an independent restaurant group", "Independent dog walkers in Berlin".
 *
 * IT IS `null` IN THE DEEP-RESEARCH PATH TODAY, and that is a plumbing gap
 * rather than an oversight: `route.ts` knows the projectId, but
 * `createCoreChatAgent` -> `getTools` -> `deepResearch` never carries it, so the
 * tool cannot ask the database. The parameter exists anyway so that closing the
 * gap is passing one string here, not rewriting the ranking — and so the gap is
 * visible in the type rather than living in a commit message.
 *
 * THE FALLBACK IS THE FOUNDER'S OWN TURNS, which the tool does have. Only turns
 * with role `user` are read: the assistant's words describe the conversation,
 * not the buyer, and an assistant aside about developers would otherwise
 * overrule what the founder said. They are scanned with the SAME markers, and
 * `conflicting-signals` still guards a founder who names both audiences:
 * UNKNOWN, not "technical". The bias is deliberate and one-way — when in doubt
 * we must not return the developer ordering, because returning it by accident
 * is the entire bug.
 *
 * WHAT THE FOUNDER SAYS ABOUT THEMSELVES DOES NOT COUNT AGAINST THE BUYER. The
 * markers are first looked for with the founder's self-descriptions removed
 * (`withoutSelfDescriptions`): "I'm a software engineer building a bedtime app
 * for parents of toddlers" names parents, and "engineer" is who is typing. Only
 * when nothing else in the text names a buyer are the self-descriptions read
 * after all, because a founder who says "I'm a dog walker" and nothing more
 * about who they are building for is, until told otherwise, their own buyer —
 * which is what this function answered before, so that case does not change.
 * A buyer description that itself names both audiences ("for parents and for
 * developers") is not a self-description and still reads as conflicting.
 */
export function readAudience(input: {
  targetUserFact: string | null;
  /** The conversation by turn. Only `user` turns are read. */
  conversation: readonly { role: string; text: string }[];
}): AudienceView {
  const fact = input.targetUserFact?.trim() ?? "";
  const founderTurns = input.conversation
    .filter((turn) => turn.role === "user")
    .map((turn) => turn.text)
    .join("\n");
  const source = fact.length > 0 ? fact : founderTurns;
  if (source.trim().length === 0) {
    return { known: false, reason: "no-segment-stated" };
  }

  // The buyer's words, apart from who is describing them. `segment` is the text
  // the decision was made on, so the subreddit table is matched against the
  // buyer and not against the founder's job.
  let text = withoutSelfDescriptions(source);
  if (
    matched(text, TECHNICAL_MARKERS).length === 0 &&
    matched(text, NON_TECHNICAL_MARKERS).length === 0
  ) {
    text = source;
  }
  const technical = matched(text, TECHNICAL_MARKERS);
  const nonTechnical = matched(text, NON_TECHNICAL_MARKERS);

  if (technical.length > 0 && nonTechnical.length > 0) {
    return { known: false, reason: "conflicting-signals" };
  }
  if (technical.length > 0) {
    return {
      known: true,
      audience: "technical",
      segment: text,
      evidence: technical.join(", "),
    };
  }
  if (nonTechnical.length > 0) {
    return {
      known: true,
      audience: "non-technical",
      segment: text,
      evidence: nonTechnical.join(", "),
    };
  }
  return { known: false, reason: "no-segment-stated" };
}

// ─────────────────────────────────────────────────────────────────────────────
// (b) WHAT THAT MEANS FOR THE SOURCES.
// ─────────────────────────────────────────────────────────────────────────────

export type SourceRanking = {
  /**
   * A MULTIPLIER on the relevance the sidecar already computed, per lane.
   * Never 0, never absent: a lane the buyer does not read is deprioritised, and
   * a deprioritised lane still runs, still reports, and still wins when its
   * evidence is overwhelmingly better.
   */
  weights: Readonly<Record<SignalSourceId, number>>;
  /**
   * Subreddits the Arctic Shift lane is asked about. EMPTY MEANS DO NOT ASK —
   * see `sourceOptionsFor`.
   */
  communities: readonly string[];
  /** Why this ordering, in prose, for the log and for the researcher model. */
  rationale: string;
};

/**
 * FOR A BUYER WHO IS NOT A DEVELOPER, in weights: Reddit, then general web,
 * then — a long way down — Hacker News.
 *
 * Hacker News at 0.25 means an HN thread needs four times the lexical relevance
 * of a Reddit thread to outrank it. That is the honest strength of the claim:
 * parents of 3-8 year olds do not post about bedtime routines on Hacker News, so
 * an HN result on that topic is usually a founder discussing the market rather
 * than a buyer describing the problem — which is precisely the "credit
 * enthusiasm as evidence" failure the *Verifying Demand* phase exists to catch.
 * It is 0.25 and not 0 because occasionally it IS the buyer, and a filter would
 * hide that.
 *
 * GitHub sits just above it for the same reason and no better one: a
 * non-technical buyer does not file issues either.
 */
const NON_TECHNICAL_WEIGHTS: Readonly<Record<SignalSourceId, number>> = {
  "arctic-shift": 1,
  "web-keyless": 0.85,
  github: 0.3,
  hackernews: 0.25,
};

/**
 * FOR A DEVELOPER-TOOLS BUYER. Hacker News is not demoted here — for this buyer
 * it is the right room, and the point of ranking by audience is that it cuts
 * both ways.
 *
 * The Reddit lane stays high rather than dropping away: r/devops, r/webdev and
 * r/ExperiencedDevs are where the same people complain at greater length. The
 * general web lands last because for a technical buyer it mostly returns
 * vendor marketing about the category rather than practitioners in it.
 */
const TECHNICAL_WEIGHTS: Readonly<Record<SignalSourceId, number>> = {
  hackernews: 1,
  github: 0.95,
  "arctic-shift": 0.8,
  "web-keyless": 0.75,
};

/**
 * WHEN NO BUYER HAS BEEN ESTABLISHED — a named ordering with a defence, not a
 * default.
 *
 * The general web leads because it is the ONLY lane that commits to no
 * audience: SearXNG will return parenting blogs, trade press and developer
 * documentation alike, so it is the least wrong thing to rank first when we do
 * not know who we are looking for. The Reddit archive follows, because Reddit
 * spans both populations. Hacker News and GitHub rank BELOW both, and this is
 * the part that matters: they are narrow, single-population corpora, and with
 * no buyer named a narrow lane must not lead a broad one. Ranking HN first
 * under uncertainty is exactly the accident this file exists to remove, so
 * "unknown" resolves here, deliberately, and not by falling through to
 * `TECHNICAL_WEIGHTS`.
 *
 * It carries NO communities, so the Arctic Shift lane is asked about no
 * subreddits and answers with its own written refusal naming the parameter it
 * needs. That refusal reaches the founder through the per-lane report, which is
 * a better outcome than a guess: it tells them that naming their buyer is what
 * unlocks the Reddit lane.
 */
export const NEUTRAL_RANKING: SourceRanking = {
  weights: {
    "web-keyless": 1,
    "arctic-shift": 0.7,
    hackernews: 0.55,
    github: 0.55,
  },
  communities: [],
  rationale:
    "No buyer segment is established for this project, so sources are ranked neutrally: the general web first because it commits to no audience, then Reddit, then Hacker News and GitHub — which are narrow developer corpora and must not lead when the buyer is unknown. Naming a target user would rank these for that buyer and would let the Reddit archive be asked about specific subreddits, which it needs before it will search at all.",
};

/**
 * WHICH SUBREDDITS TO ASK ABOUT, per buyer context.
 *
 * This table is the whole reason the Arctic Shift lane can run. That adapter
 * REFUSES a query with no subreddits, deliberately — Arctic Shift's `query`
 * parameter is documented as working only alongside `subreddit` or `author`, so
 * there is no way to search all of Reddit for a phrase and an unscoped result
 * would read as "we searched and found little" when no search happened. So the
 * lane was enabled and still refused every single request, because
 * `sidecarWebSearch` never sent `options`.
 *
 * FIRST MATCH WINS, most specific first. A miss yields NO subreddits and the
 * adapter's own refusal, which names the parameter — a visible gap the founder
 * can close, rather than r/all wearing a segment's name.
 *
 * The first row is the worked example in this file's header, parents of young
 * children, and the spec names its four subreddits verbatim. The rest are drawn
 * from segments the live fact store already holds.
 *
 * EVERY NAME BELOW WAS PROBED against the live Arctic Shift API on 2026-08-22
 * and returned real threads, casing included — r/Mommit and r/ExperiencedDevs
 * are spelled the way the archive spells them. A subreddit that does not exist
 * is not an error there; it is an empty result, which would arrive as "we
 * searched Reddit and found nothing" and be exactly the wrong sentence.
 */
const COMMUNITY_TABLE: readonly {
  /** Only a segment read as this audience is matched against the row. */
  readonly audience: BuyerAudience;
  readonly match: RegExp;
  readonly subreddits: readonly string[];
}[] = [
  {
    // Parents of young children — the worked example in this file's header.
    audience: "non-technical",
    match:
      /\b(parents?|mums?|moms?|dads?|kids|children|toddlers?|preschool\w*|kindergarten|nursery|bedtime)\b/i,
    subreddits: ["Parenting", "daddit", "Mommit", "kindergarten"],
  },
  {
    // Classroom staff. Distinct from parents: different room, different budget.
    audience: "non-technical",
    match: /\b(teachers?|educators?|classrooms?|tutors?|curriculum)\b/i,
    subreddits: ["Teachers", "education", "ELATeachers"],
  },
  {
    // Independent operators and their back office — the bookkeeper segment.
    audience: "non-technical",
    match:
      /\b(small[- ]business(es)?|bookkeepers?|accountants?|invoic\w+|restaurants?|salons?|shop ?owners?)\b/i,
    subreddits: ["smallbusiness", "Bookkeeping", "Entrepreneur"],
  },
  {
    // Pet services — the dog-walker segment. Animal phrases, not bare "pets":
    // "pets vs cattle" is infrastructure talk.
    audience: "non-technical",
    match:
      /\b(dogs?|cats?|pet (owners?|parents?|sitters?)|veterinar\w+|groomers?|dog walkers?)\b/i,
    subreddits: ["dogs", "pets", "petsitting"],
  },
  {
    // Practitioners, for a developer-tools buyer.
    audience: "technical",
    match:
      /\b(developers?|devs|engineers?|programmers?|dev-?ops|kubernetes|terraform|sysadmins?)\b/i,
    subreddits: ["devops", "webdev", "ExperiencedDevs", "programming"],
  },
];

/**
 * Rows for the audience the segment was read as, so a technical buyer who
 * mentions cats is never sent to r/dogs and a parent who mentions engineers
 * is never sent to r/devops.
 */
function communitiesFor(
  segment: string,
  audience: BuyerAudience
): readonly string[] {
  for (const row of COMMUNITY_TABLE) {
    if (row.audience === audience && row.match.test(segment)) {
      return row.subreddits;
    }
  }
  return [];
}

/** PURE. The ranking this buyer gets, with the reasoning attached. */
export function rankSourcesFor(view: AudienceView): SourceRanking {
  if (!view.known) {
    return NEUTRAL_RANKING;
  }
  const communities = communitiesFor(view.segment, view.audience);
  const reddit =
    communities.length > 0
      ? `The Reddit archive is asked about r/${communities.join(", r/")}.`
      : "No subreddit set matches this segment, so the Reddit archive is not asked about any and will refuse with the reason it writes itself.";

  if (view.audience === "technical") {
    return {
      weights: TECHNICAL_WEIGHTS,
      communities,
      rationale: `The buyer is technical (matched: ${view.evidence}), so Hacker News and GitHub rank first — for this buyer they are the room the buyer is actually in. ${reddit}`,
    };
  }
  return {
    weights: NON_TECHNICAL_WEIGHTS,
    communities,
    rationale: `The buyer is not a developer (matched: ${view.evidence}), so Reddit ranks first, the general web second, and Hacker News last — an HN thread about this market is usually other founders, not the buyer. Hacker News still runs and still appears; it needs about four times the relevance of a Reddit result to lead. ${reddit}`,
  };
}

/**
 * PURE. Every descriptor, best-fit first. NOTHING IS FILTERED.
 *
 * This ordering is what the founder sees: `describeLanes` emits one row per
 * descriptor in the order it is given them, and `ResearchLanes` renders that
 * order. So the lane report itself states the ranking — Reddit at the top,
 * Hacker News at the bottom, every lane present with its own outcome — without
 * any component needing to know that ranking exists.
 *
 * A stable sort, so lanes of equal weight keep their registry order rather than
 * shuffling between runs.
 */
export function orderProviders(
  descriptors: readonly ProviderDescriptor[],
  ranking: SourceRanking
): ProviderDescriptor[] {
  return descriptors
    .map((descriptor, index) => ({ descriptor, index }))
    .sort(
      (a, b) =>
        ranking.weights[b.descriptor.id] - ranking.weights[a.descriptor.id] ||
        a.index - b.index
    )
    .map((entry) => entry.descriptor);
}

/**
 * Floor under the relevance term.
 *
 * Without it, a query where every lane scores 0.0 relevance — which happens,
 * `token_overlap_relevance` returns exactly 0 on no token overlap — collapses
 * every lane's rank score onto the same 0 and the audience weighting becomes
 * unreadable at precisely the moment there is nothing else to rank on. The
 * floor is not a claim that a zero-relevance item is 5% relevant; it is what
 * keeps the weight, which IS known, from being multiplied into nothing.
 */
const RELEVANCE_FLOOR = 0.05;

/** PURE. The audience-weighted score for one signal. */
function rankScore(signal: DemandSignal, ranking: SourceRanking): number {
  const weight = ranking.weights[signal.sourceId];
  return weight * (RELEVANCE_FLOOR + (1 - RELEVANCE_FLOOR) * signal.relevance);
}

/**
 * PURE. Reorders signals by audience fit. RETURNS EVERY SIGNAL IT WAS GIVEN.
 *
 * A weighting must never silently drop a source, so this is a sort and not a
 * filter — the count out equals the count in, and a lane that ranks last is
 * still in the list and still in the lane report. Stable, so the sidecar's own
 * relevance ordering within a lane survives untouched: this is a weighting
 * INPUT on top of `app/pipeline/rerank.py`, not a second opinion about it.
 */
export function rankSignals(
  signals: readonly DemandSignal[],
  ranking: SourceRanking
): DemandSignal[] {
  return signals
    .map((signal, index) => ({ signal, index }))
    .sort(
      (a, b) =>
        rankScore(b.signal, ranking) - rankScore(a.signal, ranking) ||
        a.index - b.index
    )
    .map((entry) => entry.signal);
}

/**
 * PURE. The `options` each source is sent, or `undefined` when there are none.
 *
 * ONLY the Arctic Shift lane takes options today, and only subreddits. An empty
 * community list returns `undefined` rather than `{subreddits: []}` on purpose:
 * both refuse, but the adapter's refusal for a missing parameter names the
 * parameter, and sending an empty list would be asserting that we chose to
 * search no subreddits.
 */
export function sourceOptionsFor(
  ranking: SourceRanking
): Partial<Record<SignalSourceId, Record<string, unknown>>> | undefined {
  if (ranking.communities.length === 0) {
    return;
  }
  return { "arctic-shift": { subreddits: [...ranking.communities] } };
}
