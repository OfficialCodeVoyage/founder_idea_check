/**
 * NOTHING CALLS THIS ANY MORE. It formatted the balance the sidebar's user
 * menu showed, and that display was removed: the app sells nothing and runs
 * on the operator's own keys, so `UserCredit.credits` only records spend. It
 * stays, with its test, until removing a test file is approved
 * (`scripts/test-integrity.sh` fails a change that deletes one).
 *
 * THE CREDIT BALANCE, IN THE UNIT IT IS ACTUALLY STORED IN.
 *
 * `UserCredit.credits` is an `integer` of CENTS ("Balance in cents. Default =
 * $0.50" in lib/db/schema.ts), and every consumer treats it that way. The
 * sidebar rendered `((credits ?? 0) / 100).toFixed(2)` beside a dollar-sign
 * icon, which is right for a known balance and WRONG for an unknown one: the
 * balance was `number | undefined` while the query was in flight or after it
 * failed, and `?? 0` printed that as `$0.00` — a real balance of zero. Same
 * shape as the `context_window: 0` placeholder that stood in for "the gateway
 * did not report one".
 *
 * "We do not know yet" gets its own glyph.
 */

/** Rendered when the balance has not been read. NOT "0.00". */
export const UNKNOWN_BALANCE = "—";

export function formatCreditBalance(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) {
    return UNKNOWN_BALANCE;
  }
  return (cents / 100).toFixed(2);
}
