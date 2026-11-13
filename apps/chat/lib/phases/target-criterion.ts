/**
 * THE SHAPE OF A FOUNDER'S CRITERION MARK — the one definition.
 *
 * A founder can mark a user message as answering one exit criterion; the
 * client sends the id as `metadata.targetCriterionId`. That value is client
 * text, so three places refuse anything not shaped like a criterion id, and
 * they must agree:
 *
 *  - the chat route's `normalizeChatMessage`, an early filter so this request's
 *    message never carries a malformed mark into the prompt path;
 *  - `lib/message-conversion.ts::chatMessageToDbMessage`, the guard on every
 *    write of a Message row, whichever route saves it;
 *  - `lib/phases/runtime.ts::buildPhaseSystemBlock`, before it looks the id up
 *    among the current phase's exit criteria;
 *
 * and the database's `Message_target_criterion_shape` CHECK, which spells the
 * same pattern in SQL (migration 0054). A writer that let through a value the
 * CHECK refuses would fail the whole save instead of losing a hint.
 *
 * Shape only. Whether the id names a criterion of the CURRENT phase is decided
 * per turn by `buildPhaseSystemBlock`, because a saved mark must still read
 * back as what the founder said after the phase has moved on.
 *
 * PURE: no imports, so the route, the DB mapping and the phase runtime can all
 * depend on it without depending on each other.
 */
const TARGET_CRITERION_ID_SHAPE = /^[a-z0-9-]{1,64}$/;

export function isTargetCriterionId(value: unknown): value is string {
  return typeof value === "string" && TARGET_CRITERION_ID_SHAPE.test(value);
}
