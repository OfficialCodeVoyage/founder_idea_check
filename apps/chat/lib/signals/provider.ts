import type {
  DemandSignal,
  DeploymentMode,
  ProviderDescriptor,
  SignalFailure,
  SignalFetchOutcome,
  SignalSourceId,
} from "./types";

/**
 * THE DEMAND-SIGNAL GATE. Decides which sources a given deployment may query,
 * before any of them is called.
 *
 * This is the mechanism that makes a source with legal exposure (the Reddit
 * policy in `./providers.ts`) safe to ship, and it is the one piece of the
 * research subsystem that exists nowhere in open source — no
 * research tool found in the sweep gates a source on the operator's legal
 * position rather than on whether a key is present.
 *
 * Same discipline as `lib/phases/gate.ts`: a PURE half, fully unit-tested, that
 * makes every decision, and ONE injected async seam (`fetch` on each provider)
 * for the part that touches the network. This file imports nothing.
 *
 * DIRECTION OF THE GUARDS: every "cannot determine" branch resolves to
 * DISABLED. A source that runs when it should not is a legal exposure that
 * cannot be undone once the data is stored; a source that fails to run is a
 * thinner report. Those are not symmetric, so the defaults are not symmetric.
 */

// ─────────────────────────────────────────────────────────────────────────────
// (a) THE PURE PART.
// ─────────────────────────────────────────────────────────────────────────────

export type GateOutcome =
  | { allowed: true; reason: string }
  | { allowed: false; kind: "disabled" | "missing-credential"; reason: string };

/**
 * PURE. Decides whether one source may run in one deployment.
 *
 * Rule order is most-restrictive-first with flat early returns, and every
 * refusal interpolates the specific failing thing into `reason` at the point of
 * decision.
 */
export function decideProviderGate(
  descriptor: ProviderDescriptor,
  mode: DeploymentMode
): GateOutcome {
  // 1. The mode-specific bar. This is the legal gate and it is not overridable
  //    by the operator toggle: `operatorEnabled` is a request to turn on
  //    something already permitted, never a permission to turn on something
  //    barred. Checking it FIRST is what makes that true.
  if (mode.hosted && !descriptor.enabledInHosted) {
    return {
      allowed: false,
      kind: "disabled",
      reason: `${descriptor.label} is off in hosted mode. ${descriptor.gateReason}`,
    };
  }
  if (!(mode.hosted || descriptor.enabledInSelfHost)) {
    return {
      allowed: false,
      kind: "disabled",
      reason: `${descriptor.label} is off in self-host mode. ${descriptor.gateReason}`,
    };
  }

  // 2. The operator has to have asked for it. Default-off means default-off:
  //    an absent entry is a refusal, not a shrug.
  if (!mode.operatorEnabled.includes(descriptor.id)) {
    return {
      allowed: false,
      kind: "disabled",
      reason: `${descriptor.label} is not enabled for this deployment.`,
    };
  }

  // 3. Credentials. A configured-on source with no credential must not fall
  //    back to a keyless path — that fallback is exactly how a BYO-credential
  //    source silently becomes a keyless scraper.
  const available = new Set(mode.availableCredentials);
  const missing = descriptor.requiredCredentials.filter(
    (name) => !available.has(name)
  );
  if (missing.length > 0) {
    return {
      allowed: false,
      kind: "missing-credential",
      reason: `${descriptor.label} is enabled but ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set. It will not fall back to a keyless path.`,
    };
  }

  return {
    allowed: true,
    reason: `${descriptor.label} is enabled${descriptor.requiredCredentials.length > 0 ? " and credentialed" : " (keyless)"}.`,
  };
}

export type ProviderSelection = {
  enabled: ProviderDescriptor[];
  /** Every refusal, with its reason, so the UI can explain a thin report. */
  refused: { descriptor: ProviderDescriptor; outcome: GateOutcome }[];
};

/** PURE. Partitions a descriptor list into runnable and refused. */
export function selectEnabledProviders(
  descriptors: readonly ProviderDescriptor[],
  mode: DeploymentMode
): ProviderSelection {
  const enabled: ProviderDescriptor[] = [];
  const refused: ProviderSelection["refused"] = [];

  for (const descriptor of descriptors) {
    const outcome = decideProviderGate(descriptor, mode);
    if (outcome.allowed) {
      enabled.push(descriptor);
    } else {
      refused.push({ descriptor, outcome });
    }
  }

  return { enabled, refused };
}

/** PURE. Turns a refusal into the failure a caller records against the source. */
export function gateRefusalToFailure(
  descriptor: ProviderDescriptor,
  outcome: Extract<GateOutcome, { allowed: false }>
): SignalFailure {
  return {
    kind: outcome.kind,
    sourceId: descriptor.id,
    detail: outcome.reason,
  };
}

/**
 * PURE. Drops signals that cannot be cited or attributed to a real source, then
 * dedupes by url across every source.
 *
 * An uncitable demand signal is worse than a missing one. The *Verifying
 * Demand* gate reads these as evidence, and a signal with no permalink is a
 * claim the founder cannot check and the gate cannot verify — which is exactly
 * the "credit enthusiasm as evidence" failure the persona is written to avoid.
 */
export function sanitizeSignals(
  signals: readonly DemandSignal[]
): DemandSignal[] {
  const seen = new Set<string>();
  const kept: DemandSignal[] = [];
  for (const signal of signals) {
    const url = signal.url.trim();
    const title = signal.title.trim();
    if (url.length === 0 || title.length === 0) {
      continue;
    }
    if (!(url.startsWith("https://") || url.startsWith("http://"))) {
      continue;
    }
    const key = url.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    kept.push({ ...signal, url, title });
  }
  return kept;
}

export type SignalHarvest = {
  signals: DemandSignal[];
  failures: SignalFailure[];
  /** Source ids that returned at least one usable signal. */
  sourcesWithSignals: SignalSourceId[];
  /**
   * True when nothing was found AND at least one source was blocked or
   * unavailable. The *Verifying Demand* gate must treat this as "we could not
   * look", not as "we looked and nobody cares" — the second reading would BLOCK
   * a founder for a datacenter IP problem that has nothing to do with them.
   */
  inconclusive: boolean;
};

/** PURE. Merges per-source outcomes without hiding what went wrong. */
export function harvestSignals(
  outcomes: readonly SignalFetchOutcome[],
  gateFailures: readonly SignalFailure[] = []
): SignalHarvest {
  const signals: DemandSignal[] = [];
  const failures: SignalFailure[] = [...gateFailures];
  const sourcesWithSignals: SignalSourceId[] = [];

  for (const outcome of outcomes) {
    if (outcome.ok) {
      const usable = sanitizeSignals(outcome.signals);
      if (usable.length > 0) {
        sourcesWithSignals.push(outcome.sourceId);
      }
      signals.push(...usable);
      continue;
    }
    failures.push(outcome.failure);
  }

  const looked = failures.some(
    (f) =>
      f.kind === "blocked" ||
      f.kind === "unavailable" ||
      f.kind === "rate-limited"
  );

  return {
    signals: sanitizeSignals(signals),
    failures,
    sourcesWithSignals,
    inconclusive: sanitizeSignals(signals).length === 0 && looked,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// (b) THE IMPURE PART. One async function over the injected provider fetches.
// ─────────────────────────────────────────────────────────────────────────────

export type HarvestDeps = {
  /**
   * Resolves a descriptor to its fetcher. Injected rather than imported so a
   * test can supply four closures and never touch the sidecar.
   */
  fetcherFor: (
    descriptor: ProviderDescriptor
  ) => (
    query: import("./types").SignalQuery,
    abortSignal?: AbortSignal
  ) => Promise<SignalFetchOutcome>;
};

export type HarvestInput = {
  descriptors: readonly ProviderDescriptor[];
  mode: DeploymentMode;
  query: import("./types").SignalQuery;
  abortSignal?: AbortSignal;
};

/**
 * Gates, then fans out across every permitted source concurrently.
 *
 * NEVER REJECTS. A provider that throws despite the contract becomes an
 * `unavailable` failure rather than taking the harvest down — `Promise.all`
 * over raw fetches would lose three good sources to one bad one.
 */
export async function runSignalHarvest(
  deps: HarvestDeps,
  input: HarvestInput
): Promise<SignalHarvest> {
  const selection = selectEnabledProviders(input.descriptors, input.mode);
  const gateFailures = selection.refused.map(({ descriptor, outcome }) =>
    gateRefusalToFailure(
      descriptor,
      outcome as Extract<GateOutcome, { allowed: false }>
    )
  );

  const outcomes = await Promise.all(
    selection.enabled.map(async (descriptor): Promise<SignalFetchOutcome> => {
      try {
        return await deps.fetcherFor(descriptor)(
          input.query,
          input.abortSignal
        );
      } catch (error) {
        return {
          ok: false,
          failure: {
            kind: "unavailable",
            sourceId: descriptor.id,
            detail: `${descriptor.label} threw instead of returning a failure: ${error instanceof Error ? error.message : String(error)}`,
          },
        };
      }
    })
  );

  return harvestSignals(outcomes, gateFailures);
}
