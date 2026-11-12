import {
  type GateOutcome,
  gateRefusalToFailure,
  selectEnabledProviders,
} from "@/lib/signals/provider";
import type {
  DeploymentMode,
  ProviderDescriptor,
  SignalFailure,
} from "@/lib/signals/types";
import type { SearchAPI } from "./configuration";

/**
 * PREFLIGHT — CAN THIS DEPLOYMENT RESEARCH ANYTHING AT ALL?
 *
 * On 2026-08-21 a founder's first message asked for a source-cited study with
 * primary sources. The model offered one. `deepResearch` then ran with an empty
 * message list, produced 15 research-update parts and ZERO citations, and the
 * founder only learned that four of six source lanes were switched off by
 * asking "why am I only seeing Y Combinator?".
 *
 * The gate that knew all of this already existed. `decideProviderGate` refuses
 * each source with a written reason, and `runSignalHarvest` collects those
 * refusals — but it does so per REQUEST, which is after the model has already
 * promised the founder a sourced study. NOTHING NEW IS DECIDED HERE. This reads
 * exactly the same verdict, from exactly the same function, one step earlier:
 * before the tool is described to the model.
 *
 * The direction of the guard matches lib/signals/provider.ts. A deployment that
 * cannot research must say so; a deployment that can is free to try and fail
 * per-source, which the per-lane report then explains.
 */

export type ResearchAvailability =
  | {
      available: true;
      /**
       * Human labels of the lanes that may run. Labels rather than ids because
       * this string reaches the model's tool description and, through the lane
       * report, a founder — and "web-keyless" is not a thing a founder knows.
       */
      lanes: readonly string[];
    }
  | {
      available: false;
      /** One sentence naming the cause. Never blank, never an SDK internal. */
      headline: string;
      /**
       * Every refusal, verbatim, from `decideProviderGate`. EMPTY WHEN THERE
       * WERE NO LANES TO REFUSE — a deployment with no sidecar and no cloud key
       * has nothing to gate, and inventing a refusal per source would describe
       * a gate decision that never happened.
       */
      refusals: readonly SignalFailure[];
    };

const NO_BACKEND =
  "No search backend is configured: researchSidecarUrl in chat.config.ts is empty and neither TAVILY_API_KEY nor FIRECRAWL_API_KEY is set.";

const EVERY_LANE_REFUSED =
  "Every research source is switched off for this deployment.";

/**
 * Names ids that matched no descriptor. Mirrors `describeUnknownSourceIds` in
 * sidecar-search.ts, and for the same reason `/v1/health` reports them: a typo
 * in RESEARCH_ENABLED_SOURCES must read as a typo, not as a source that ran and
 * found nothing.
 */
function describeUnknownSourceIds(ids: readonly string[]): string {
  if (ids.length === 0) {
    return "";
  }
  const noun = ids.length === 1 ? "an id" : "ids";
  return ` RESEARCH_ENABLED_SOURCES also names ${noun} that match no source: ${ids.join(", ")}.`;
}

/** The cloud arms are a single opaque lane: a key is either set or it is not. */
const CLOUD_LANE_LABEL: Partial<Record<SearchAPI, string>> = {
  tavily: "Tavily web search",
  firecrawl: "Firecrawl web search",
};

/** PURE. The whole decision, from state the caller already has. */
export function decideResearchAvailability(input: {
  searchApi: SearchAPI;
  mode: DeploymentMode;
  descriptors: readonly ProviderDescriptor[];
  unknownSourceIds: readonly string[];
}): ResearchAvailability {
  const cloudLane = CLOUD_LANE_LABEL[input.searchApi];
  if (cloudLane) {
    return { available: true, lanes: [cloudLane] };
  }

  if (input.searchApi === "none") {
    return {
      available: false,
      headline: NO_BACKEND + describeUnknownSourceIds(input.unknownSourceIds),
      refusals: [],
    };
  }

  const selection = selectEnabledProviders(input.descriptors, input.mode);
  if (selection.enabled.length > 0) {
    return {
      available: true,
      lanes: selection.enabled.map((descriptor) => descriptor.label),
    };
  }

  return {
    available: false,
    headline:
      EVERY_LANE_REFUSED + describeUnknownSourceIds(input.unknownSourceIds),
    refusals: selection.refused.map(({ descriptor, outcome }) =>
      gateRefusalToFailure(
        descriptor,
        outcome as Extract<GateOutcome, { allowed: false }>
      )
    ),
  };
}

/**
 * The founder-facing refusal.
 *
 * A REFUSAL THAT NAMES ITS REASON IS THE PRODUCT — the same principle the phase
 * gate is built on, applied to research, where it was not applied at all. The
 * reasons are reproduced in full: `decideProviderGate` wrote them for a human,
 * and a summarised legal rationale is one a founder cannot act on.
 */
export function researchUnavailableMessage(
  view: Extract<ResearchAvailability, { available: false }>
): string {
  const lines = [
    `Deep research is unavailable on this deployment. Nothing was searched, so treat this as "we could not look" — not as "there is no evidence".`,
    "",
    view.headline,
  ];
  if (view.refusals.length > 0) {
    lines.push("", "Per source:");
    for (const refusal of view.refusals) {
      lines.push(`- ${refusal.sourceId} (${refusal.kind}): ${refusal.detail}`);
    }
  }
  return lines.join("\n");
}

/**
 * What the MODEL is told, folded into the tool description at registration.
 *
 * This is the half that actually prevents the observed failure. The founder's
 * message arrived, the model read a description promising "multiple web
 * sources" and "citations", and offered a sourced study it could not deliver.
 * A description that opens by refusing is read before that offer is made.
 */
export function researchToolDescriptionFor(
  view: ResearchAvailability,
  baseDescription: string
): string {
  if (view.available) {
    return `${baseDescription}

Sources reachable on this deployment: ${view.lanes.join(", ")}. Do not promise sources beyond these.`;
  }
  return `THIS TOOL IS UNAVAILABLE ON THIS DEPLOYMENT AND WILL RETURN NOTHING. Do not call it, and do not offer the user a sourced study, a citation, or primary-source research — you cannot produce one. Tell the user research is unavailable and why:

${researchUnavailableMessage(view)}`;
}
