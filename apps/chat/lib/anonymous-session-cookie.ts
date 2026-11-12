import { ANONYMOUS_LIMITS, type AnonymousSession } from "./types/anonymous";

/**
 * The anonymous-session cookie is `<payload>.<signature>`: the payload is the
 * base64url JSON of an AnonymousSession, the signature an HMAC of it that only
 * the server can make (`lib/anonymous-session-server.ts`). The browser reads
 * the payload to show the remaining credits; only the server writes the cookie
 * and only the server's verified read decides what a visitor may spend.
 */

const BASE64_PADDING = /=+$/;

function toBase64Url(value: string): string {
  return btoa(value)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(BASE64_PADDING, "");
}

function fromBase64Url(value: string): string {
  return atob(value.replaceAll("-", "+").replaceAll("_", "/"));
}

export function encodeAnonymousSessionPayload(
  session: AnonymousSession
): string {
  return toBase64Url(
    JSON.stringify({
      id: session.id,
      remainingCredits: session.remainingCredits,
      createdAt: session.createdAt.toISOString(),
    })
  );
}

export function splitAnonymousSessionCookie(
  value: string
): { payload: string; signature: string } | null {
  const [payload, signature, ...rest] = value.split(".");
  return payload && signature && rest.length === 0
    ? { payload, signature }
    : null;
}

/**
 * Parses a payload into a session, or null when it is malformed, out of range
 * or expired. Signature checking is the caller's job.
 */
export function decodeAnonymousSessionPayload(
  payload: string
): AnonymousSession | null {
  try {
    const raw: unknown = JSON.parse(fromBase64Url(payload));
    if (!raw || typeof raw !== "object") {
      return null;
    }
    const { id, remainingCredits, createdAt } = raw as Record<string, unknown>;
    if (
      typeof id !== "string" ||
      typeof remainingCredits !== "number" ||
      !Number.isInteger(remainingCredits) ||
      remainingCredits < 0 ||
      remainingCredits > ANONYMOUS_LIMITS.CREDITS ||
      typeof createdAt !== "string"
    ) {
      return null;
    }
    const created = new Date(createdAt);
    if (
      Number.isNaN(created.getTime()) ||
      Date.now() - created.getTime() > ANONYMOUS_LIMITS.SESSION_DURATION
    ) {
      return null;
    }
    return { id, remainingCredits, createdAt: created };
  } catch {
    return null;
  }
}
