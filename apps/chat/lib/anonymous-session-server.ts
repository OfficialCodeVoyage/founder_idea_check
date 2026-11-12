// Server-only, deliberately NOT "use server": as a server action,
// setAnonymousSession would let any caller write an anonymous session with
// whatever remainingCredits it chose. The only caller is the /api/chat route
// handler; the browser only reads the cookie (lib/anonymous-session-client.ts).
import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { env } from "@/lib/env";
import type { AnonymousSession } from "@/lib/types/anonymous";
import { ANONYMOUS_LIMITS } from "@/lib/types/anonymous";
import {
  decodeAnonymousSessionPayload,
  encodeAnonymousSessionPayload,
  splitAnonymousSessionCookie,
} from "./anonymous-session-cookie";
import { ANONYMOUS_SESSION_COOKIES_KEY } from "./constants";

/**
 * The cookie is signed so a visitor cannot raise their own credits by editing
 * it. The purpose prefix keeps this HMAC from being valid for anything else
 * signed with AUTH_SECRET.
 */
function sign(payload: string): Buffer {
  return createHmac("sha256", env.AUTH_SECRET)
    .update(`anonymous-session:${payload}`)
    .digest();
}

function isValidSignature(payload: string, signature: string): boolean {
  const expected = sign(payload);
  const given = Buffer.from(signature, "base64url");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * The visitor's verified anonymous session, or null. A missing, unsigned,
 * badly signed, malformed or expired cookie is null, and the caller starts a
 * fresh session with default credits: tampering can never yield more than a
 * new visitor gets.
 */
export async function getAnonymousSession(): Promise<AnonymousSession | null> {
  const cookieStore = await cookies();
  const value = cookieStore.get(ANONYMOUS_SESSION_COOKIES_KEY)?.value;
  if (!value) {
    return null;
  }
  const parts = splitAnonymousSessionCookie(value);
  if (!(parts && isValidSignature(parts.payload, parts.signature))) {
    return null;
  }
  return decodeAnonymousSessionPayload(parts.payload);
}

export async function setAnonymousSession(
  session: AnonymousSession
): Promise<void> {
  const payload = encodeAnonymousSessionPayload(session);
  const signature = sign(payload).toString("base64url");
  const cookieStore = await cookies();
  cookieStore.set(ANONYMOUS_SESSION_COOKIES_KEY, `${payload}.${signature}`, {
    path: "/",
    maxAge: ANONYMOUS_LIMITS.SESSION_DURATION,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
}
