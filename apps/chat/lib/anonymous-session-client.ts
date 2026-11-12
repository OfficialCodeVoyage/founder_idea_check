"use client";
import type { AnonymousSession } from "@/lib/types/anonymous";
import {
  decodeAnonymousSessionPayload,
  splitAnonymousSessionCookie,
} from "./anonymous-session-cookie";
import { ANONYMOUS_SESSION_COOKIES_KEY } from "./constants";

function getCookie(name: string): string | null {
  if (typeof document === "undefined") {
    return null;
  }

  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  if (parts.length === 2) {
    const cookieValue = parts.pop()?.split(";").shift() || null;
    return cookieValue ? decodeURIComponent(cookieValue) : null;
  }
  return null;
}

/**
 * Read-only, for display. The server writes and signs this cookie
 * (`lib/anonymous-session-server.ts`) and verifies it before any spend; the
 * browser cannot check the signature and never writes the cookie.
 */
export function getAnonymousSession(): AnonymousSession | null {
  const value = getCookie(ANONYMOUS_SESSION_COOKIES_KEY);
  const parts = value ? splitAnonymousSessionCookie(value) : null;
  return parts ? decodeAnonymousSessionPayload(parts.payload) : null;
}
