import { electron } from "@better-auth/electron";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { lastLoginMethod } from "better-auth/plugins";
import { env } from "@/lib/env";
import { config } from "./config";
import { db } from "./db/client";
import { schema } from "./db/schema";
import {
  ELECTRON_AUTH_CLIENT_ID,
  ELECTRON_AUTH_COOKIE_PREFIX,
  ELECTRON_TRUSTED_ORIGINS,
} from "./electron-auth";
import { getBaseUrl } from "./url";

type BetterAuthOptions = Parameters<typeof betterAuth>[0];
type BetterAuthPlugin = NonNullable<BetterAuthOptions["plugins"]>[number];

const electronAuthPlugin = electron({
  clientID: ELECTRON_AUTH_CLIENT_ID,
  cookiePrefix: ELECTRON_AUTH_COOKIE_PREFIX,
}) as unknown as BetterAuthPlugin;
/**
 * The auth base URL and every trusted origin come from this deployment's own
 * URL (`lib/url.ts::getBaseUrl`), never from `config.appUrl`: that value is
 * committed in `chat.config.ts`, a fork inherits it pointing at a domain it
 * does not own, and trusting it would let that domain make cookie-bearing auth
 * requests here. A production server with no URL of its own falls back to
 * localhost, which only makes its auth POSTs fail with INVALID_ORIGIN; say so
 * loudly instead of failing quietly. `scripts/check-env.ts` already fails the
 * build in that case.
 */
const baseUrl = getBaseUrl();
if (process.env.NODE_ENV === "production" && !(env.APP_URL || env.VERCEL_URL)) {
  console.error(
    `APP_URL is not set: auth trusts only ${baseUrl}, so sign-in from any other origin is refused. Set APP_URL to this deployment's public URL.`
  );
}

/**
 * The committed `.env.local` ships placeholder OAuth values so the env
 * validator passes and the app boots. Registering a provider with them yields a
 * sign-in button that can never succeed (the OAuth host rejects the client_id),
 * so treat a placeholder exactly like an unset variable.
 */
const PLACEHOLDER_CREDENTIAL_PATTERN = /^(?:placeholder|changeme|your[-_])/i;

function readOAuthCredential(value: string | undefined): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return;
  }
  return PLACEHOLDER_CREDENTIAL_PATTERN.test(value) ? undefined : value;
}

export const auth = betterAuth({
  baseURL: baseUrl,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
  }),
  trustedOrigins: [
    baseUrl,
    // This deployment's own Vercel URL (previews, and the per-deployment URL
    // of a production build).
    ...(env.VERCEL_URL ? [`https://${env.VERCEL_URL}`] : []),
    ...(config.desktopApp.enabled ? ELECTRON_TRUSTED_ORIGINS : []),
  ],
  secret: env.AUTH_SECRET,

  session: {
    cookieCache: {
      enabled: true,
      maxAge: 60 * 5, // 5 minutes - reduces database queries for session validation
    },
  },

  socialProviders: (() => {
    const googleId = readOAuthCredential(env.AUTH_GOOGLE_ID);
    const googleSecret = readOAuthCredential(env.AUTH_GOOGLE_SECRET);
    const githubId = readOAuthCredential(env.AUTH_GITHUB_ID);
    const githubSecret = readOAuthCredential(env.AUTH_GITHUB_SECRET);
    const vercelId = readOAuthCredential(env.VERCEL_APP_CLIENT_ID);
    const vercelSecret = readOAuthCredential(env.VERCEL_APP_CLIENT_SECRET);

    const google =
      typeof googleId === "string" &&
      googleId.length > 0 &&
      typeof googleSecret === "string" &&
      googleSecret.length > 0
        ? { clientId: googleId, clientSecret: googleSecret }
        : undefined;

    const github =
      typeof githubId === "string" &&
      githubId.length > 0 &&
      typeof githubSecret === "string" &&
      githubSecret.length > 0
        ? { clientId: githubId, clientSecret: githubSecret }
        : undefined;

    const vercel =
      typeof vercelId === "string" &&
      vercelId.length > 0 &&
      typeof vercelSecret === "string" &&
      vercelSecret.length > 0
        ? { clientId: vercelId, clientSecret: vercelSecret }
        : undefined;

    return { google, github, vercel } as const;
  })(),
  plugins: [
    lastLoginMethod(),
    nextCookies(),
    ...(config.desktopApp.enabled ? [electronAuthPlugin] : []),
  ],
});

// Infer session type from the auth instance for type safety
export type Session = typeof auth.$Infer.Session;
