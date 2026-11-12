/**
 * THE WALL-CLOCK BUDGET OF ONE `POST /api/chat`, in milliseconds.
 *
 * The route's abort timer and every deadline inside a deep-research run are
 * derived from this one number. They used to be two: the route had a bare
 * `290_000`, and the research pipeline had no deadline at all, so a run that
 * spent its time searching was cut off by the route in the middle of writing
 * its report (live QA 2026-11-12: aborted at 289 s with 3,087 characters of
 * the report written, saved only as a partial document).
 *
 * 290 s sits 10 s under the 300 s a serverless function is commonly allowed,
 * so the route aborts and persists what it has before the platform kills it.
 * Change it here and the research deadlines move with it
 * (tools/platform/deep-research/research-clock.ts).
 */
export const CHAT_REQUEST_BUDGET_MS = 290_000;
