import { config } from "@/lib/config";
import { env } from "@/lib/env";
import {
  ALL_PROVIDERS,
  parseOperatorEnabledSources,
} from "@/lib/signals/providers";
import type { DeploymentMode } from "@/lib/signals/types";

/**
 * WHERE THIS DEPLOYMENT SITS, read once and shared by every caller that gates.
 *
 * Lifted out of sidecar-search.ts so the preflight in deep-research.ts asks the
 * SAME question of the SAME environment. Two readers computing a `DeploymentMode`
 * independently is how the app and the sidecar came to disagree about
 * RESEARCH_ENABLED_SOURCES in the first place, and a preflight that answered
 * from a second copy would be free to say "research is available" about a
 * deployment whose search tool then refused every lane.
 */

/**
 * Every credential any descriptor asks for, derived from the descriptors
 * themselves rather than restated. A hardcoded list here would drift the first
 * time a source is added, and `decideProviderGate` would then refuse it for a
 * credential the operator had actually set.
 */
const CREDENTIAL_ENV_NAMES: readonly string[] = [
  ...new Set(ALL_PROVIDERS.flatMap((provider) => provider.requiredCredentials)),
];

/**
 * READ FROM `RESEARCH_ENABLED_SOURCES`, NOT HARDCODED.
 *
 * This used to pin `operatorEnabled` to `DEFAULT_ENABLED_SOURCE_IDS`, which
 * made the variable a lie on this side: an operator could switch a source on,
 * the sidecar would agree to serve it, and the app would still refuse it here
 * — before any request — with the reason "not enabled for this deployment".
 * True sentence, false cause, and no way to tell from the report which of the
 * two locks was shut.
 *
 * The unknown ids come back alongside rather than folded in, for the same
 * reason `/v1/health` reports them: a typo must not present as a source that
 * ran and found nothing.
 */
export function currentDeployment(): {
  mode: DeploymentMode;
  unknownSourceIds: readonly string[];
} {
  const values = env as unknown as Record<string, string | undefined>;
  const requested = parseOperatorEnabledSources(
    values.RESEARCH_ENABLED_SOURCES
  );
  return {
    mode: {
      hosted: config.ai.tools.deepResearch.hosted,
      availableCredentials: CREDENTIAL_ENV_NAMES.filter((name) => {
        const value = values[name];
        return typeof value === "string" && value.length > 0;
      }),
      // The operator's request, which the gate may still refuse.
      operatorEnabled: requested.enabled,
    },
    unknownSourceIds: requested.unknown,
  };
}
