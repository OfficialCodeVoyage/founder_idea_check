import { env } from "@/lib/env";

/**
 * Returns the base URL of this deployment.
 * Priority: APP_URL > the Vercel project's production domain (production
 * deployments only) > VERCEL_URL > localhost.
 *
 * Every candidate is a URL this deployment owns. `chat.config.ts` deliberately
 * has no `appUrl`: a committed URL is inherited by every fork pointing at a
 * domain it does not own, so the page metadata (`app/layout.tsx::metadata`),
 * the sitemap and auth (`lib/auth.ts::auth`) all read this function instead.
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
