import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "./client";
import { userCredit } from "./schema";

async function ensureUserCreditRow(userId: string) {
  await db.insert(userCredit).values({ userId }).onConflictDoNothing();
}

/**
 * Records `amount` cents of spend against the user. `UserCredit.credits` is a
 * spend meter, not a balance anyone pays into: the app runs on the operator's
 * own provider keys and sells nothing, so nothing reads it to refuse a turn,
 * a tool or a simulation, and it may go below zero.
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
 * Takes back a `deductCredits` amount recorded up front for a call that turned
 * out never to reach the model (`app/actions/run-simulation.ts::runProjectSimulation`).
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
