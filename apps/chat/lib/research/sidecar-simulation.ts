import type { SimulationRunner } from "./simulation";

/**
 * The `SimulationRunner` seam, backed by the `apps/research` sidecar.
 *
 * `runSimulation` in simulation.ts owns every decision — seeding, divergence,
 * the verdict — and is pure and unit-tested. This file is only the socket, so
 * a test drives the whole feature by passing its own closure instead.
 *
 * IT RETURNS THE RAW BODY AND JUDGES NOTHING. `runSimulation` already parses
 * both the success and the failure shape, so translating a non-200 into an
 * exception here would convert a named, structured failure the UI can render
 * into a stack trace it cannot.
 */

const TRAILING_SLASHES = /\/+$/;

/** Long: a real OASIS run pulls a model per persona per round. */
const DEFAULT_TIMEOUT_MS = 300_000;

export type SidecarSimulationConfig = {
  /** e.g. `http://localhost:8099`. Empty disables the lane entirely. */
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export function createSidecarSimulationRunner(
  config: SidecarSimulationConfig
): SimulationRunner {
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = config.baseUrl.replace(TRAILING_SLASHES, "");

  return async (payload) => {
    if (!base) {
      // Structured, not thrown: an unconfigured sidecar is an operator
      // condition with a remedy, and the UI should say so rather than show a
      // network error.
      return {
        ok: false,
        kind: "disabled",
        detail:
          "No research sidecar is configured, so no simulation can run. Set researchSidecarUrl in chat.config.ts (or RESEARCH_SIDECAR_URL) and start apps/research.",
      };
    }

    const response = await fetchImpl(`${base}/v1/simulate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        personas: payload.personas,
        pitch: payload.pitch,
        rounds: payload.rounds,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    return await response.json();
  };
}
