import type {
  GateDecisionValue,
  KnownFact,
  TranscriptTurn,
} from "@/lib/phases/types";

/**
 * CALIBRATION FIXTURES — phase 1, "problem-validation".
 *
 * Step 4 of the build plan: 12 transcripts per gate-critical phase, 4 per band,
 * asserted against the gate's real verdict. These are the ground truth the gate
 * is calibrated against; they are NOT unit-test inputs and never run under
 * `test:unit` (that suite runs with every AI key unset, on purpose).
 *
 * DIVERGENCE FROM THE PLAN, deliberate: the plan specified promptfoo's
 * `llm-rubric` as the assertion. The gate does not emit free text — it emits a
 * three-valued enum. Grading an enum with a second LLM would add a grader that
 * drifts (the plan's own stated risk) to measure a judge that drifts. So the
 * assertion here is exact equality against `expected`, and the only model in
 * the loop is the one under calibration.
 *
 * HOW TO READ `expected` vs `band`:
 *   expected — the single verdict this transcript SHOULD produce.
 *   band     — verdicts that are defensible. A verdict inside the band but not
 *              equal to `expected` is a calibration wobble worth seeing; a
 *              verdict outside the band is a calibration FAILURE.
 * `bad` fixtures have band ["BLOCK"] with no slack at all. That is the
 * property the product is: a bad transcript must never be a way through.
 *
 * EVERY fixture carries facts. A fixture with zero facts would BLOCK on
 * decideGate guard 6 (minFactsRequired) before the judge's output is even
 * consulted, which calibrates the guard rather than the judge. Even the weakest
 * transcripts below therefore establish at least one fact.
 */
export type GateFixture = {
  id: string;
  band: "good" | "mediocre" | "bad";
  /** What this fixture is designed to discriminate. Shown on failure. */
  tests: string;
  expected: GateDecisionValue;
  acceptable: GateDecisionValue[];
  transcript: TranscriptTurn[];
  facts: KnownFact[];
};

const t = (role: "user" | "assistant", text: string): TranscriptTurn => ({
  role,
  text,
});

// ─────────────────────────────────────────────────────────────────────────────
// GOOD — every blocking criterion carries rubric-acceptable evidence, five or
// more interviews, validation score comfortably over 100. Expect PASS.
// ─────────────────────────────────────────────────────────────────────────────

const GOOD: GateFixture[] = [
  {
    id: "good-dental-claims",
    band: "good",
    tests:
      "full evidence: money already spent, behaviour observed, 7 interviews",
    expected: "PASS",
    acceptable: ["PASS"],
    transcript: [
      t(
        "user",
        "Practice managers at 3-6 chair dental clinics lose time reworking rejected insurance claims. I interviewed 7 of them across Manchester and Leeds over five weeks."
      ),
      t(
        "assistant",
        "How often does a rejection happen, and what does one cost them?"
      ),
      t(
        "user",
        "I pulled the claim logs from three of the practices. Rejection rate is 11-14% of submitted claims, so roughly 18-25 rejections a week each. Each one takes 20-35 minutes to correct and resubmit — I timed four of them sitting next to Priya at Exampleton Dental. That is about 8 hours a week of a practice manager's time on £22/hour, so £700-800 a month in labour, plus the cash-flow delay of 30-45 days on the money itself."
      ),
      t("assistant", "What do they already do about it?"),
      t(
        "user",
        "Two of the seven pay a virtual assistant in the Philippines £380 and £420 a month specifically to resubmit claims — I saw the invoices. Three keep a colour-coded spreadsheet of the payer-specific rejection reasons and hand-check every claim before submitting. One bought Jarvis Analytics at $99/month, used it for two months, and cancelled because it reported rejections but did not fix them. Only one does nothing, and she is the one-chair practice."
      ),
      t("assistant", "Has anyone named a price?"),
      t(
        "user",
        "The two paying the VA both said they would move that budget to software tomorrow if it worked — that is £380-420 a month already leaving their account for exactly this. A third asked me unprompted what I would charge and said £150 a month was 'obviously fine' given what a rejection costs her. I scored it frequency 4, intensity 4, workarounds 5, willingness 4 — 320."
      ),
    ],
    facts: [
      {
        key: "problem_statement",
        value:
          "Practice managers at 3-6 chair dental clinics spend 8h/week reworking rejected insurance claims",
        confidence: 90,
      },
      {
        key: "target_user",
        value: "Practice manager at a 3-6 chair UK dental clinic",
        confidence: 90,
      },
      {
        key: "problem_frequency",
        value:
          "18-25 claim rejections per practice per week (from claim logs at 3 practices)",
        confidence: 85,
      },
      {
        key: "problem_intensity",
        value:
          "~8h/week at £22/hour = £700-800/month, plus 30-45 day cash-flow delay",
        confidence: 85,
      },
      {
        key: "existing_workarounds",
        value:
          "2 of 7 pay a VA £380-420/month (invoices seen); 3 keep payer-specific rejection spreadsheets; 1 bought and churned from Jarvis Analytics at $99/month",
        confidence: 90,
      },
      {
        key: "willingness_to_pay",
        value:
          "£380-420/month already being spent on VAs for this task; one manager named £150/month unprompted",
        confidence: 85,
      },
      {
        key: "evidence_type",
        value:
          "Claim logs pulled from 3 practices, 4 timed observations, VA invoices, 7 interviews",
        confidence: 90,
      },
      { key: "people_interviewed", value: "7", confidence: 95 },
      { key: "validation_score", value: "320", confidence: 80 },
    ],
  },
  {
    id: "good-freight-detention",
    band: "good",
    tests: "full evidence via a consultant already paid, 6 interviews",
    expected: "PASS",
    acceptable: ["PASS"],
    transcript: [
      t(
        "user",
        "Dispatchers at 10-40 truck US freight carriers fail to claim detention pay they are owed when a shipper holds a driver past the free window. I have spoken to 6 dispatchers at 6 different carriers."
      ),
      t("assistant", "How often, and what is it worth?"),
      t(
        "user",
        "I went through 90 days of ELD data with two of them. Detention events past two hours ran 60-80 a month per carrier. Their contracted detention rate is $50-75/hour, so the unclaimed money is $9k-14k a month per carrier. They lose it because claiming requires matching the ELD timestamp to the bill of lading and filing inside 30 days, and the dispatcher is busy covering loads."
      ),
      t("assistant", "What are they doing about it today?"),
      t(
        "user",
        "One carrier pays a consultant $1,200 a month to do detention reconciliation two days a week — I saw the contract. Three run a Friday-afternoon spreadsheet ritual where they reconcile whatever they can remember. One tried McLeod's detention module, which their TMS already includes, and abandoned it because it does not read the ELD feed. The sixth writes it off entirely and told me it is 'the cost of doing business', which he then priced at about $100k a year."
      ),
      t("assistant", "Willingness to pay?"),
      t(
        "user",
        "The $1,200 a month consultant contract is the number — that carrier's owner told me he would pay the same for software that did it daily instead of weekly. Two others said $500-800 a month without me suggesting a figure. Frequency 5, intensity 4, workarounds 4, willingness 4 = 320."
      ),
    ],
    facts: [
      {
        key: "problem_statement",
        value:
          "Dispatchers at 10-40 truck US carriers fail to claim owed detention pay because reconciliation is manual and time-boxed to 30 days",
        confidence: 90,
      },
      {
        key: "target_user",
        value: "Dispatcher at a 10-40 truck US freight carrier",
        confidence: 90,
      },
      {
        key: "problem_frequency",
        value:
          "60-80 detention events over 2 hours per carrier per month (90 days of ELD data, 2 carriers)",
        confidence: 85,
      },
      {
        key: "problem_intensity",
        value: "$9k-14k/month unclaimed per carrier at contracted $50-75/hour",
        confidence: 85,
      },
      {
        key: "existing_workarounds",
        value:
          "One pays a reconciliation consultant $1,200/month (contract seen); three run a weekly spreadsheet; one tried and abandoned the McLeod detention module",
        confidence: 90,
      },
      {
        key: "willingness_to_pay",
        value:
          "$1,200/month consultant contract already being paid; two others named $500-800/month unprompted",
        confidence: 85,
      },
      {
        key: "evidence_type",
        value:
          "90 days of ELD data at 2 carriers, consultant contract, 6 interviews",
        confidence: 90,
      },
      { key: "people_interviewed", value: "6", confidence: 95 },
      { key: "validation_score", value: "320", confidence: 80 },
    ],
  },
  {
    id: "good-trial-deviations",
    band: "good",
    tests: "evidence is a prior purchase then churn — spending is proven",
    expected: "PASS",
    acceptable: ["PASS"],
    transcript: [
      t(
        "user",
        "Clinical research coordinators at community oncology sites log protocol deviations by hand and miss the sponsor's reporting window. I interviewed 9 coordinators across 6 sites."
      ),
      t("assistant", "Frequency and cost?"),
      t(
        "user",
        "I sat in on two site days. A busy site running 12-18 trials logs 25-40 deviations a month. Each one takes 15-40 minutes because the coordinator has to find the source document, restate the deviation in the sponsor's wording, and enter it in whichever EDC that sponsor uses — a site typically juggles 4-7 different EDC portals. Two sites showed me sponsor findings letters from their last audit; one had a corrective action plan that cost them 30 hours of the principal investigator's time."
      ),
      t("assistant", "Existing workarounds?"),
      t(
        "user",
        "Every site has a shared deviation spreadsheet, and four have a weekly 'deviation huddle' on the calendar. Two of the six bought Florence eBinders at roughly $400 a month per site, used it for a year, and dropped it — it stores documents but does not track deviation deadlines. One coordinator built an Access database herself in 2019 and still maintains it."
      ),
      t("assistant", "Willingness to pay?"),
      t(
        "user",
        "The two sites that bought Florence spent about $4,800 each over that year on the adjacent problem. Their research directors both told me the budget line still exists and is unspent. One named $300 a month per site as an easy approval because it sits under the sponsor pass-through threshold. Frequency 4, intensity 5, workarounds 4, willingness 4 = 320."
      ),
    ],
    facts: [
      {
        key: "problem_statement",
        value:
          "Clinical research coordinators at community oncology sites miss sponsor reporting windows for protocol deviations logged by hand across 4-7 EDC portals",
        confidence: 90,
      },
      {
        key: "target_user",
        value:
          "Clinical research coordinator at a community oncology site running 12-18 trials",
        confidence: 90,
      },
      {
        key: "problem_frequency",
        value:
          "25-40 deviations per site per month (observed over 2 site days)",
        confidence: 85,
      },
      {
        key: "problem_intensity",
        value:
          "15-40 min each; one audit finding cost 30 hours of PI time in a corrective action plan",
        confidence: 85,
      },
      {
        key: "existing_workarounds",
        value:
          "Shared deviation spreadsheets at all 6 sites; weekly deviation huddles at 4; two bought and churned from Florence eBinders at ~$400/month; one hand-built Access database",
        confidence: 90,
      },
      {
        key: "willingness_to_pay",
        value:
          "~$4,800/year already spent per site on Florence; budget line unspent; $300/month named as under the pass-through approval threshold",
        confidence: 85,
      },
      {
        key: "evidence_type",
        value:
          "2 observed site days, sponsor findings letters, prior purchase records, 9 interviews",
        confidence: 90,
      },
      { key: "people_interviewed", value: "9", confidence: 95 },
      { key: "validation_score", value: "320", confidence: 80 },
    ],
  },
  {
    id: "good-game-localisation",
    band: "good",
    tests: "exactly five interviews — the advisory threshold's boundary",
    expected: "PASS",
    acceptable: ["PASS"],
    transcript: [
      t(
        "user",
        "Producers at 5-25 person indie game studios ship localisation bugs because nobody plays the translated build before release. I interviewed 5 producers who have each shipped at least two titles."
      ),
      t("assistant", "How often does this bite, and how badly?"),
      t(
        "user",
        "All five have shipped a title with broken localisation. I read the Steam review histories with them: two had review scores drop from Very Positive to Mixed within a week of a Japanese or Korean release because of text overflow and untranslated UI strings. One studio's Simplified Chinese launch generated 340 negative reviews in nine days and they estimate it cost them the entire Chinese market for that title — the producer put it at $40-60k of lost revenue. It happens on essentially every non-English launch: five studios, eleven launches, nine with a localisation defect that reached players."
      ),
      t("assistant", "What do they do about it now?"),
      t(
        "user",
        "Three hire native-speaker contractors on Upwork for a one-week LQA pass at $1,800-2,400 per title — two of them showed me the invoices. One asks their Discord community to volunteer, which they described as 'begging'. One does nothing and eats the reviews. Two also keep a screenshot spreadsheet of every string that has overflowed before, so they can re-check it manually next time."
      ),
      t("assistant", "Willingness to pay?"),
      t(
        "user",
        "The $1,800-2,400 per title is money already out the door, two to four titles a year. One producer said she would pay $500 a month standing rather than scramble for a contractor each launch. Frequency 3, intensity 5, workarounds 4, willingness 5 = 300."
      ),
    ],
    facts: [
      {
        key: "problem_statement",
        value:
          "Producers at 5-25 person indie studios ship localisation defects because no one plays the translated build pre-release",
        confidence: 90,
      },
      {
        key: "target_user",
        value:
          "Producer at a 5-25 person indie game studio shipping non-English releases",
        confidence: 90,
      },
      {
        key: "problem_frequency",
        value:
          "9 of 11 non-English launches across 5 studios shipped a localisation defect",
        confidence: 85,
      },
      {
        key: "problem_intensity",
        value:
          "Review score drops from Very Positive to Mixed; one Simplified Chinese launch drew 340 negative reviews and an estimated $40-60k lost",
        confidence: 85,
      },
      {
        key: "existing_workarounds",
        value:
          "3 hire Upwork native-speaker LQA contractors at $1,800-2,400/title (invoices seen); 1 solicits Discord volunteers; 2 keep string-overflow screenshot spreadsheets",
        confidence: 90,
      },
      {
        key: "willingness_to_pay",
        value:
          "$1,800-2,400 per title already spent, 2-4 titles/year; one producer named $500/month standing",
        confidence: 85,
      },
      {
        key: "evidence_type",
        value:
          "Steam review histories read with producers, contractor invoices, 5 interviews",
        confidence: 90,
      },
      { key: "people_interviewed", value: "5", confidence: 95 },
      { key: "validation_score", value: "300", confidence: 80 },
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// MEDIOCRE — one criterion is deliberately weak and everything else is strong.
// This is where calibration actually lives: a lenient judge PASSes these, and a
// paranoid one BLOCKs the advisory-only case. Three expect BLOCK (the weak
// criterion is blocking); one expects WARN (the weak criterion is advisory).
// ─────────────────────────────────────────────────────────────────────────────

const MEDIOCRE: GateFixture[] = [
  {
    id: "mediocre-hypothetical-wtp",
    band: "mediocre",
    tests:
      "willingness-to-pay is hypothetical only — the rubric's explicit kill trigger",
    expected: "BLOCK",
    acceptable: ["BLOCK"],
    transcript: [
      t(
        "user",
        "Warehouse shift supervisors at 50-200 person 3PL sites rebuild the next day's labour plan by hand every evening because the WMS forecast ignores who actually called in sick. I interviewed 6 supervisors at 4 sites."
      ),
      t("assistant", "Frequency and intensity?"),
      t(
        "user",
        "Every single evening shift — I watched three of them do it. It takes 40-70 minutes at the end of an already long day. When they get it wrong the site either pays 8-15 hours of unplanned overtime or misses the carrier cutoff, and one site showed me a month where cutoff misses cost them £11,000 in expedited freight."
      ),
      t("assistant", "Existing workarounds?"),
      t(
        "user",
        "All six maintain a personal spreadsheet the WMS knows nothing about. Two sites have a WhatsApp group where team leads post absences before 6am. One supervisor built a Google Sheet with a solver script that he has been refining for two years and now shares with two other sites."
      ),
      t("assistant", "Has anyone paid for a fix, or named a number?"),
      t(
        "user",
        "No, nobody is spending anything on it today. But when I described what I would build, five of the six said they would definitely pay for it, and one said his ops director would probably sign off on something in the low hundreds a month. I think it is clearly a real budget."
      ),
    ],
    facts: [
      {
        key: "problem_statement",
        value:
          "Warehouse shift supervisors at 3PL sites rebuild the next day's labour plan by hand nightly because the WMS forecast ignores same-day absences",
        confidence: 90,
      },
      {
        key: "target_user",
        value: "Shift supervisor at a 50-200 person 3PL warehouse",
        confidence: 90,
      },
      {
        key: "problem_frequency",
        value: "Every evening shift; observed at 3 sites",
        confidence: 85,
      },
      {
        key: "problem_intensity",
        value:
          "40-70 min/night; 8-15h unplanned overtime or missed carrier cutoffs; one site lost £11,000 in expedited freight in a month",
        confidence: 85,
      },
      {
        key: "existing_workarounds",
        value:
          "Personal spreadsheets at all 6; WhatsApp absence groups at 2 sites; one hand-built Google Sheet solver shared across 3 sites",
        confidence: 90,
      },
      {
        key: "willingness_to_pay",
        value:
          "Nothing spent today; 5 of 6 said they would 'definitely pay'; one guessed his ops director would approve 'low hundreds a month'",
        confidence: 40,
      },
      {
        key: "evidence_type",
        value:
          "3 observed evening shifts, one site's expedited freight invoices, 6 interviews",
        confidence: 85,
      },
      { key: "people_interviewed", value: "6", confidence: 95 },
    ],
  },
  {
    id: "mediocre-three-interviews",
    band: "mediocre",
    tests: "only the ADVISORY criterion misses — must WARN, not BLOCK",
    expected: "WARN",
    acceptable: ["WARN"],
    transcript: [
      t(
        "user",
        "Bookkeepers at 2-8 person UK accountancy practices re-key bank transactions that their software failed to auto-match. I have interviewed 3 of them so far — I know that is thin."
      ),
      t("assistant", "Frequency and intensity?"),
      t(
        "user",
        "I screen-recorded two of them for a full working day. Auto-match catches about 70% of lines, so on a client with 400 monthly transactions they hand-code 120. That is 90-150 minutes per client per month, and each bookkeeper carries 18-30 clients. So 30-70 hours a month per bookkeeper on £28/hour of chargeable time they cannot bill."
      ),
      t("assistant", "Existing workarounds?"),
      t(
        "user",
        "All three pay for Dext at £0.35-0.60 per document on top of Xero — I saw two invoices, £140 and £210 last month. Two also keep a personal rules spreadsheet mapping supplier names to nominal codes, one of which has 1,100 rows. One outsources the worst clients to a bookkeeper in Sri Lanka at £9/hour."
      ),
      t("assistant", "Willingness to pay?"),
      t(
        "user",
        "The Dext spend is £140-210 a month, already leaving the account for a partial fix. One partner told me she would pay £250 a month to cut the re-keying in half and showed me where it would come from in her budget. Frequency 5, intensity 4, workarounds 4, willingness 4 = 320."
      ),
    ],
    facts: [
      {
        key: "problem_statement",
        value:
          "Bookkeepers at 2-8 person UK practices hand-code the ~30% of bank transactions their software fails to auto-match",
        confidence: 90,
      },
      {
        key: "target_user",
        value: "Bookkeeper at a 2-8 person UK accountancy practice",
        confidence: 90,
      },
      {
        key: "problem_frequency",
        value:
          "~120 unmatched lines per client per month across 18-30 clients per bookkeeper",
        confidence: 85,
      },
      {
        key: "problem_intensity",
        value:
          "30-70 hours/month per bookkeeper at £28/hour of unbillable time",
        confidence: 85,
      },
      {
        key: "existing_workarounds",
        value:
          "All 3 pay for Dext at £140-210/month (2 invoices seen); 2 keep supplier-to-nominal rules spreadsheets (one 1,100 rows); 1 outsources to Sri Lanka at £9/hour",
        confidence: 90,
      },
      {
        key: "willingness_to_pay",
        value:
          "£140-210/month already spent on Dext; one partner named £250/month and showed the budget line",
        confidence: 85,
      },
      {
        key: "evidence_type",
        value: "2 full-day screen recordings, Dext invoices, 3 interviews",
        confidence: 85,
      },
      { key: "people_interviewed", value: "3", confidence: 95 },
      { key: "validation_score", value: "320", confidence: 80 },
    ],
  },
  {
    id: "mediocre-survey-evidence",
    band: "mediocre",
    tests:
      "evidence is a survey — a type the rubric explicitly does not accept",
    expected: "BLOCK",
    acceptable: ["BLOCK"],
    transcript: [
      t(
        "user",
        "School business managers at UK multi-academy trusts spend their summer reconciling per-pupil funding allocations against actual enrolment. I ran a survey and got 61 responses from business managers across 44 trusts."
      ),
      t("assistant", "What did the survey tell you about frequency and cost?"),
      t(
        "user",
        "78% said they do this reconciliation at least three times a year. 64% rated it 4 or 5 out of 5 for painfulness. The average time reported was 22 hours per cycle, and 31% said they had discovered a funding error worth more than £10,000 in the last two years."
      ),
      t("assistant", "What do they do about it now?"),
      t(
        "user",
        "The survey had a free-text box. 41 of them mentioned Excel. 12 mentioned that their trust pays an external consultant for a summer 'funding health check'. 6 named a specific tool — mostly IMP Software or Access Education Budgets."
      ),
      t("assistant", "Willingness to pay?"),
      t(
        "user",
        "I asked a price question. 54% said they would pay up to £200 a month, and 22% said up to £500. The mean of the willingness-to-pay slider was £237. That is a strong signal across 61 people, far more than the five interviews you keep asking for."
      ),
    ],
    facts: [
      {
        key: "problem_statement",
        value:
          "School business managers at UK multi-academy trusts reconcile per-pupil funding against actual enrolment several times a year",
        confidence: 70,
      },
      {
        key: "target_user",
        value: "School business manager at a UK multi-academy trust",
        confidence: 85,
      },
      {
        key: "problem_frequency",
        value:
          "78% of 61 survey respondents report 3+ reconciliation cycles per year",
        confidence: 55,
      },
      {
        key: "problem_intensity",
        value:
          "Self-reported average 22 hours per cycle; 31% report a >£10,000 funding error found in 2 years",
        confidence: 55,
      },
      {
        key: "existing_workarounds",
        value:
          "Free-text survey mentions: Excel (41), external consultant funding health check (12), IMP Software or Access Education Budgets (6)",
        confidence: 60,
      },
      {
        key: "willingness_to_pay",
        value:
          "Survey slider: 54% up to £200/month, 22% up to £500/month, mean £237 — no money observed leaving any account",
        confidence: 35,
      },
      {
        key: "evidence_type",
        value:
          "Online survey, 61 responses, 44 trusts — no interviews, no observation, no spending records",
        confidence: 90,
      },
      { key: "people_interviewed", value: "0", confidence: 90 },
    ],
  },
  {
    id: "mediocre-low-score",
    band: "mediocre",
    tests:
      "well-evidenced but genuinely mild — validation score lands under 100",
    expected: "BLOCK",
    acceptable: ["BLOCK"],
    transcript: [
      t(
        "user",
        "Product designers at Series A SaaS companies find it annoying to keep their Figma component library in sync with what is actually shipped in the codebase. I interviewed 8 designers at 8 companies."
      ),
      t("assistant", "How often does this come up, and what does it cost?"),
      t(
        "user",
        "Honestly, it comes up when they do a design system audit, which everyone told me is once or twice a year. I asked all eight to walk me through the last time it bit them. Six could name an instance; two could not remember one. When it does bite it is usually a designer using a deprecated component in a mock, caught in design review within a day or two. Nobody could point to a shipped bug or lost revenue from it. One said it costs her 'maybe two hours a quarter of irritation'."
      ),
      t("assistant", "What do they do about it?"),
      t(
        "user",
        "Five do nothing at all. Two have a recurring calendar reminder to audit the library, and one of those admitted she has skipped it three quarters running. One company has an engineer who occasionally posts a Slack message when he deprecates something."
      ),
      t("assistant", "Willingness to pay?"),
      t(
        "user",
        "Nobody is paying for anything here. Two said they would try a free tool. When I pushed on price, the most anyone would say was 'not out of my own budget'. I scored it frequency 2, intensity 2, workarounds 3, willingness 2 — that is 24."
      ),
    ],
    facts: [
      {
        key: "problem_statement",
        value:
          "Product designers at Series A SaaS companies find Figma component libraries drift from shipped code",
        confidence: 85,
      },
      {
        key: "target_user",
        value: "Product designer at a Series A SaaS company",
        confidence: 85,
      },
      {
        key: "problem_frequency",
        value: "Surfaces once or twice a year, during design system audits",
        confidence: 85,
      },
      {
        key: "problem_intensity",
        value:
          "Caught in design review within a day or two; no shipped bug or revenue loss identified; ~2 hours a quarter of irritation",
        confidence: 85,
      },
      {
        key: "existing_workarounds",
        value:
          "5 of 8 do nothing; 2 have a calendar audit reminder (one skipped 3 quarters running); 1 relies on ad-hoc engineer Slack messages",
        confidence: 85,
      },
      {
        key: "willingness_to_pay",
        value:
          "Nobody pays anything; 2 would try a free tool; 'not out of my own budget'",
        confidence: 85,
      },
      {
        key: "evidence_type",
        value: "8 interviews with a walk-through of the last concrete instance",
        confidence: 90,
      },
      { key: "people_interviewed", value: "8", confidence: 95 },
      { key: "validation_score", value: "24", confidence: 85 },
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// BAD — must BLOCK. Band is ["BLOCK"] with no slack. A PASS or WARN on any of
// these means the gate is not the product.
// ─────────────────────────────────────────────────────────────────────────────

const BAD: GateFixture[] = [
  {
    id: "bad-product-first",
    band: "bad",
    tests: "a solution with no problem and no user behind it",
    expected: "BLOCK",
    acceptable: ["BLOCK"],
    transcript: [
      t(
        "user",
        "I want to build an AI-native CRM. Every CRM today is basically a database with forms bolted on, and none of them actually use LLMs properly. Mine would read your email and your calls and just keep itself up to date."
      ),
      t("assistant", "Who specifically has told you their CRM is a problem?"),
      t(
        "user",
        "I mean, everyone hates Salesforce, that is practically a meme. The market is enormous — CRM is a $90 billion category and AI is eating software. If I capture even a tenth of a percent of that it is a huge business."
      ),
      t(
        "assistant",
        "Has anyone described a specific instance where this cost them something?"
      ),
      t(
        "user",
        "Not a specific instance, no, but I worked in sales for two years and I hated updating it. That is the whole insight really. Can we move on to the solution phase? I already have the architecture sketched out and I would rather spend the time there."
      ),
    ],
    facts: [
      {
        key: "problem_statement",
        value:
          "Founder asserts existing CRMs are databases with forms and do not use LLMs; no instance of harm described",
        confidence: 30,
      },
    ],
  },
  {
    id: "bad-no-workaround",
    band: "bad",
    tests: "nobody does anything about it — the rubric's explicit kill trigger",
    expected: "BLOCK",
    acceptable: ["BLOCK"],
    transcript: [
      t(
        "user",
        "Amateur cyclists cannot easily tell whether their bike fit is causing their knee pain. I asked 6 people at my club."
      ),
      t("assistant", "How often does it come up, and what does it cost them?"),
      t(
        "user",
        "Four of the six have had knee pain at some point in the last two years. It stops them riding for a week or two when it flares. It is genuinely miserable when it happens."
      ),
      t("assistant", "What do they do about it today?"),
      t(
        "user",
        "That is the thing — nothing, really. They wait for it to go away. I asked specifically: none of them have paid for a bike fit, none of them have watched a YouTube video about saddle height, none of them have asked a physio. One said he moved his saddle once but could not remember which direction. They just ride less for a bit and then it settles down."
      ),
      t("assistant", "Willingness to pay?"),
      t(
        "user",
        "I asked and got shrugs. One said maybe a fiver. But I still think there is something here — the pain is real, and if nobody has solved it that is a wide open space, right?"
      ),
    ],
    facts: [
      {
        key: "problem_statement",
        value:
          "Amateur cyclists get knee pain possibly caused by bike fit and cannot diagnose it",
        confidence: 60,
      },
      {
        key: "target_user",
        value: "Amateur cyclist in a club",
        confidence: 55,
      },
      {
        key: "problem_frequency",
        value:
          "4 of 6 had a flare in the last two years, lasting a week or two",
        confidence: 70,
      },
      {
        key: "existing_workarounds",
        value:
          "None — no bike fits paid for, no videos watched, no physio consulted; they simply ride less until it settles",
        confidence: 85,
      },
      {
        key: "willingness_to_pay",
        value: "Shrugs; one said 'maybe a fiver'",
        confidence: 75,
      },
      { key: "people_interviewed", value: "6", confidence: 90 },
    ],
  },
  {
    id: "bad-everyone-segment",
    band: "bad",
    tests: "'small businesses' as a segment, no named role or context",
    expected: "BLOCK",
    acceptable: ["BLOCK"],
    transcript: [
      t(
        "user",
        "Small businesses waste a huge amount of time on admin. I want to build something that takes the admin off their plate so they can focus on their actual business."
      ),
      t("assistant", "Which small businesses, and which admin?"),
      t(
        "user",
        "All of them really — plumbers, cafes, dentists, consultants. Anyone under 20 staff. The admin is invoicing, chasing payment, scheduling, tax, compliance, the usual. It is all the same problem underneath: too much paperwork, not enough hours."
      ),
      t("assistant", "Who have you spoken to?"),
      t(
        "user",
        "I have not done formal interviews yet, but I have run a small business myself and my brother runs a landscaping company and he complains about it constantly. Everyone I mention it to nods. It is a universal pain point — that is exactly why the market is so big."
      ),
      t("assistant", "Can you give me one concrete instance?"),
      t(
        "user",
        "My brother spent a Sunday doing invoices last month instead of taking his kids out. That is the kind of thing I mean."
      ),
    ],
    facts: [
      {
        key: "problem_statement",
        value:
          "Small businesses under 20 staff spend too much time on invoicing, payment chasing, scheduling, tax and compliance",
        confidence: 35,
      },
      {
        key: "target_user",
        value:
          "Any small business under 20 staff — plumbers, cafes, dentists, consultants",
        confidence: 25,
      },
      { key: "existing_workarounds", value: "Not established", confidence: 20 },
    ],
  },
  {
    id: "bad-vibes-only",
    band: "bad",
    tests: "enthusiasm and a friend's opinion presented as validation",
    expected: "BLOCK",
    acceptable: ["BLOCK"],
    transcript: [
      t(
        "user",
        "I am building a social app for finding people to go to gigs with. My flatmate said it was the best idea he had heard all year and he would use it immediately."
      ),
      t(
        "assistant",
        "Who else has said something like that, and about what specifically?"
      ),
      t(
        "user",
        "I posted the idea in two Discord servers and got about 30 fire emojis and a bunch of 'ngl this slaps'. Someone offered to design the logo for free. The vibe is genuinely really strong."
      ),
      t(
        "assistant",
        "Has anyone described a time they missed a gig because they had nobody to go with?"
      ),
      t(
        "user",
        "Not in so many words. I have though — I skipped a show in March because none of my mates were into it. That is the whole reason I want to build it. Honestly I think this is one of those things where you cannot really validate it in advance, you just have to build it and see. Can we move on?"
      ),
    ],
    facts: [
      {
        key: "problem_statement",
        value:
          "Founder skipped one gig because no friends wanted to attend; framed as a general problem of finding gig companions",
        confidence: 30,
      },
      {
        key: "evidence_type",
        value:
          "Flatmate opinion and Discord reaction emojis; no interviews, no observed behaviour, no spending",
        confidence: 85,
      },
    ],
  },
];

export const PHASE_ONE_FIXTURES: GateFixture[] = [...GOOD, ...MEDIOCRE, ...BAD];
