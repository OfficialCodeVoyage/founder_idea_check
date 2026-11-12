import { env } from "@/lib/env";

/**
 * Returns the base URL of this deployment.
 * Priority: APP_URL > the Vercel project's production domain (production
 * deployments only) > VERCEL_URL > localhost.
 *
 * Every candidate is a URL this deployment owns. `config.appUrl` is not one of
 * them: it is the public site address written in `chat.config.ts` (metadata,
 * links) and a fork ships it pointing at someone else's domain, so it must never
 * become the auth base URL or a trusted origin (`lib/auth.ts::auth`).
 */
export function getBaseUrl(): string {
  if (env.APP_URL) {
    return env.APP_URL;
  }
  if (env.VERCEL_ENV === "production" && env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (env.VERCEL_URL) {
    return `https://${env.VERCEL_URL}`;
  }
  return "http://localhost:3000";
}
