import "server-only";
import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "./client";
import { userCredit } from "./schema";

async function ensureUserCreditRow(userId: string) {
  await db.insert(userCredit).values({ userId }).onConflictDoNothing();
}

/**
 * Get user's current credit balance (in cents).
 */
export async function getCredits(userId: string): Promise<number> {
  let rows = await db
    .select({ credits: userCredit.credits })
    .from(userCredit)
    .where(eq(userCredit.userId, userId))
    .limit(1);

  if (rows.length === 0) {
    await ensureUserCreditRow(userId);
    rows = await db
      .select({ credits: userCredit.credits })
      .from(userCredit)
      .where(eq(userCredit.userId, userId))
      .limit(1);
  }

  return rows[0]?.credits ?? 0;
}

/**
 * Check if user has positive credits (can spend).
 */
export async function canSpend(userId: string): Promise<boolean> {
  const credits = await getCredits(userId);
  return credits > 0;
}

/**
 * Deduct credits from user. Allows going slightly negative for in-progress operations.
 */
export async function deductCredits(
  userId: string,
  amount: number
): Promise<void> {
  await ensureUserCreditRow(userId);
  await db
    .update(userCredit)
    .set({
      credits: sql`${userCredit.credits} - ${amount}`,
    })
    .where(eq(userCredit.userId, userId));
}

/**
 * Deducts `amount` only if the balance is positive, in one statement, and
 * says whether it did. For a paid call whose cost is taken BEFORE it runs
 * (`app/actions/run-simulation.ts::runProjectSimulation`): `canSpend` followed
 * by `deductCredits` lets concurrent requests all pass the check on the same
 * last cent, while Postgres re-checks this WHERE after taking the row lock, so
 * only the first of them is admitted. Like `deductCredits` it may leave the
 * balance slightly negative when `amount` exceeds what is left.
 */
export async function reserveCredits(
  userId: string,
  amount: number
): Promise<boolean> {
  await ensureUserCreditRow(userId);
  const rows = await db
    .update(userCredit)
    .set({
      credits: sql`${userCredit.credits} - ${amount}`,
    })
    .where(and(eq(userCredit.userId, userId), gt(userCredit.credits, 0)))
    .returning({ credits: userCredit.credits });
  return rows.length > 0;
}

/**
 * Add credits to user: hands back a `reserveCredits` amount for a call that
 * turned out never to reach the model.
 */
export async function addCredits(
  userId: string,
  amount: number
): Promise<void> {
  await ensureUserCreditRow(userId);
  await db
    .update(userCredit)
    .set({
      credits: sql`${userCredit.credits} + ${amount}`,
    })
    .where(eq(userCredit.userId, userId));
}
