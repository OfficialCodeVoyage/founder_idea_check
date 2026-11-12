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
 * THE SECOND GUARD, not the first. The first is the bind:
 * `scripts/dev-local.sh` and the `dev` scripts start `next dev --hostname
 * localhost`, so nothing off this machine can open a socket to the server at
 * all. This exists because the route hands a 30-day session for the founder's
 * real account to whoever calls it, so a server started some other way (a
 * bare `next dev`, which listens on every interface) must not turn into "anyone
 * on the same Wi-Fi is signed in as you".
 *
 * A route handler cannot see the socket's address, so this reads two headers
 * and uses each ONLY TO REFUSE, never to grant:
 *  - `Host` must name a loopback host. A LAN caller who addresses the machine
 *    by its IP fails here, and so does a DNS-rebinding page in the founder's
 *    own browser (its Host is the attacker's domain).
 *  - `X-Forwarded-For` must be present and every hop loopback. Next fills it
 *    from the socket's remote address when the client sent none
 *    (`next/dist/server/base-server.js`, `??=`), so a LAN caller who does not
 *    forge it is refused. A caller CAN forge both headers, which is why a
 *    loopback value here proves nothing on its own and the bind stays the
 *    control that matters.
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
  if (!isLoopbackRequest(request)) {
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
