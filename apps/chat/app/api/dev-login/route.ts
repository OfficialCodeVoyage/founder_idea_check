import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { session, user } from "@/lib/db/schema";
import { env } from "@/lib/env";

async function serializeSignedCookie(
  name: string,
  value: string,
  secret: string,
  opt: {
    path?: string;
    httpOnly?: boolean;
    sameSite?: string;
    expires?: Date;
  }
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value)
  );
  const base64Sig = btoa(String.fromCharCode(...new Uint8Array(signature)));
  const signedValue = encodeURIComponent(`${value}.${base64Sig}`);

  let cookie = `${name}=${signedValue}`;
  if (opt.path) {
    cookie += `; Path=${opt.path}`;
  }
  if (opt.expires) {
    cookie += `; Expires=${opt.expires.toUTCString()}`;
  }
  if (opt.httpOnly) {
    cookie += "; HttpOnly";
  }
  if (opt.sameSite) {
    cookie += `; SameSite=${opt.sameSite.charAt(0).toUpperCase() + opt.sameSite.slice(1)}`;
  }
  return cookie;
}

const IPV4_LOOPBACK_RE = /^127(?:\.\d{1,3}){3}$/;
const IPV6_BRACKETED_RE = /^\[(.*)\]$/;
const HOST_PORT_RE = /:\d+$/;

function isLoopbackAddress(raw: string): boolean {
  const address = raw.trim().toLowerCase().replace(IPV6_BRACKETED_RE, "$1");
  if (address === "::1" || address === "0:0:0:0:0:0:0:1") {
    return true;
  }
  const v4 = address.startsWith("::ffff:") ? address.slice(7) : address;
  return IPV4_LOOPBACK_RE.test(v4);
}

function isLoopbackHost(hostHeader: string | null): boolean {
  if (!hostHeader) {
    return false;
  }
  const host = hostHeader.trim().toLowerCase().replace(HOST_PORT_RE, "");
  return host === "localhost" || isLoopbackAddress(host);
}

/**
 * THE BIND MARKER — the guard that actually holds. The route hands a 30-day
 * session for the founder's real account to whoever calls it, so it must only
 * exist on a server nothing off this machine can reach. `scripts/dev-local.sh`
 * and the chat `dev` / `dev:inspect` scripts start `next dev --hostname
 * localhost` AND set this variable in the same command; a server started any
 * other way (a bare `next dev`, which listens on every interface) lacks it, and
 * the route answers 404 there.
 *
 * Why a marker rather than trusting the headers below: a route handler cannot
 * see the socket's address, and Next KEEPS a client-sent `X-Forwarded-For`.
 * On a server listening on every interface, a machine on the same Wi-Fi that
 * sends `Host: localhost` and `X-Forwarded-For: 127.0.0.1` passes
 * `isLoopbackRequest`. The marker is what ties the shortcut to the bind.
 */
const DEV_SERVER_LOCALHOST_ONLY_ENV = "IC_DEV_SERVER_LOCALHOST_ONLY";

function isStartedBoundToLocalhost(): boolean {
  return process.env[DEV_SERVER_LOCALHOST_ONLY_ENV] === "1";
}

/**
 * THE HEADER CHECKS, kept behind the marker. They do not stop a caller who
 * forges them (see above); they stop the callers who do not bother — and a
 * DNS-rebinding page in the founder's own browser, whose Host is the
 * attacker's domain. Each header is used ONLY TO REFUSE, never to grant:
 *  - `Host` must name a loopback host. A LAN caller who addresses the machine
 *    by its IP fails here, and so does a DNS-rebinding page in the founder's
 *    own browser (its Host is the attacker's domain).
 *  - `X-Forwarded-For` must be present and every hop loopback. A caller who
 *    does not forge it is refused unless they really are on this machine.
 *
 * WHY "MUST BE PRESENT" DOES NOT LOCK THE FOUNDER OUT — read from the
 * installed next 16.3 source, not assumed:
 *  - `next/dist/server/base-server.js::BaseServer.handleRequestImpl` runs for
 *    every request and does
 *    `req.headers['x-forwarded-for'] ??= originalRequest.socket.remoteAddress`.
 *    So XFF is SET from the socket when the client sent none, and a
 *    client-sent value is KEPT as-is: not replaced, not appended to.
 *  - In dev the request reaches it through
 *    `next/dist/server/lib/router-server.js::requestHandlerImpl` (whose
 *    `filterInternalHeaders` list does not include XFF) and
 *    `next/dist/server/next-server.js::NextNodeServer.normalizeReq`, which
 *    wraps the real IncomingMessage, so `socket` is the real socket.
 *  - `next/dist/server/base-http/node.js::NodeNextRequest` shares the
 *    IncomingMessage's `headers` object, and
 *    `next/dist/build/templates/app-route.js` builds this handler's Request
 *    from it via `NextRequestAdapter.fromNodeNextRequest`, so the value set
 *    above is the one read here (`::1` or `127.0.0.1` for a local browser).
 * Re-check this after a Next.js major upgrade: if that `??=` goes away, this
 * rule refuses every sign-in.
 */
function isLoopbackRequest(request: Request): boolean {
  if (!isLoopbackHost(request.headers.get("host"))) {
    return false;
  }
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (!forwardedFor) {
    return false;
  }
  return forwardedFor.split(",").every(isLoopbackAddress);
}

export async function GET(request: Request) {
  if (process.env.NODE_ENV !== "development") {
    return new Response("Not found", { status: 404 });
  }
  // Same answer as production: a refused caller learns nothing about whether
  // this is a dev server with a sign-in shortcut.
  if (!(isStartedBoundToLocalhost() && isLoopbackRequest(request))) {
    return new Response("Not found", { status: 404 });
  }

  const devEmail = "dev@localhost";
  let [devUser] = await db.select().from(user).where(eq(user.email, devEmail));

  if (!devUser) {
    const id = crypto.randomUUID();
    [devUser] = await db
      .insert(user)
      .values({
        id,
        email: devEmail,
        name: "Dev User",
        emailVerified: true,
      })
      .returning();
  }

  const token = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await db.insert(session).values({
    id: crypto.randomUUID(),
    userId: devUser.id,
    token,
    expiresAt,
    createdAt: now,
    updatedAt: now,
  });

  const signedSessionCookie = await serializeSignedCookie(
    "better-auth.session_token",
    token,
    env.AUTH_SECRET,
    {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      expires: expiresAt,
    }
  );

  const headers = new Headers({ Location: "/" });
  headers.append("Set-Cookie", signedSessionCookie);

  return new Response(null, {
    status: 302,
    headers,
  });
}
