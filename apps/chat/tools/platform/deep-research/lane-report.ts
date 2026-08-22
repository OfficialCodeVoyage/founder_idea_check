import type {
  DemandSignal,
  ProviderDescriptor,
  SignalFailure,
} from "@/lib/signals/types";
import type { LaneReport } from "../research-updates-schema";

/**
 * THE PER-SOURCE OUTCOME, TURNED INTO SOMETHING THE FOUNDER CAN SEE.
 *
 * On 2026-08-21 a founder asked for a source-cited study with primary sources.
 * Zero citations came back, and they only learned why by asking "why am I only
 * seeing Y Combinator?" — four of six lanes had been switched off.
 *
 * NOTHING IS DISCOVERED HERE. `decideProviderGate` refuses each source with a
 * written reason, the sidecar answers a refused fetch with
 * `{"ok": false, source_id, kind, detail}`, and `runSignalHarvest` already
 * collects both into `SignalFailure[]`. In sidecar-search.ts all of that reached
 * `describeFailures()`, a log line, and nothing else. This is the same data,
 * shaped for the stream.
 *
 * THE PRINCIPLE IS THE PHASE GATE'S: a refusal that names its reason is the
 * product. It was applied to the gate and not to research, and research is where
 * the founder was left guessing.
 *
 * Read `LaneOutcome` in ../research-updates-schema.ts for why "ran and found
 * nothing", "refused", and "never asked" are three arms rather than three
 * numbers.
 */

/**
 * PURE. One row per descriptor, in descriptor order.
 *
 * EVERY descriptor, including the ones that were never enabled — a lane missing
 * from the list is a lane the founder cannot ask about, which is precisely the
 * position they were in.
 */
export function describeLanes(input: {
  descriptors: readonly ProviderDescriptor[];
  signals: readonly DemandSignal[];
  failures: readonly SignalFailure[];
  /**
   * False when no harvest was run at all — a malformed tool call is refused
   * before any fetch. Every lane is then `not-attempted`, because rendering
   * them as "found nothing" would claim six searches that never happened.
   */
  attempted: boolean;
}): LaneReport[] {
  return input.descriptors.map((descriptor) => ({
    sourceId: descriptor.id,
    label: descriptor.label,
    outcome: outcomeFor(descriptor, input),
  }));
}

function outcomeFor(
  descriptor: ProviderDescriptor,
  input: {
    signals: readonly DemandSignal[];
    failures: readonly SignalFailure[];
    attempted: boolean;
  }
): LaneReport["outcome"] {
  if (!input.attempted) {
    return { kind: "not-attempted" };
  }

  const returned = input.signals.filter(
    (signal) => signal.sourceId === descriptor.id
  ).length;
  // A lane that demonstrably answered outranks a failure it also recorded: with
  // one harvest per query, the same source can serve one query and be
  // rate-limited on the next, and "it produced these" is the honest headline.
  if (returned > 0) {
    return { kind: "returned", signals: returned };
  }

  const failure = input.failures.find(
    (candidate) => candidate.sourceId === descriptor.id
  );
  if (failure) {
    // VERBATIM. `decideProviderGate` and the adapters wrote these for a human.
    return {
      kind: "refused",
      failureKind: failure.kind,
      detail: failure.detail,
    };
  }

  // Enabled, asked, and answered with nothing. Not a failure — see
  // apps/research/README.md: this is the finding the *Verifying Demand* gate
  // acts on, and the one distinction the sidecar must never lose.
  return { kind: "found-nothing" };
}
