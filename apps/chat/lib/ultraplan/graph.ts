import type {
  Blocker,
  BlockerAnalysis,
  CanvasEdge,
  CanvasEdgeKind,
  CanvasGraph,
  CanvasNode,
  CanvasNodeStatus,
  CanvasNodeType,
  CanvasTask,
  DroppedEdge,
} from "./types";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ULTRAPLAN — THE CANVAS GRAPH. PURE. NO REACT, NO DOM, NO @xyflow/react.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Everything the canvas shows is decided here, in a function that takes plain
 * arrays and returns plain objects. The React layer under components/canvas/
 * is a renderer over this output and holds no graph logic of its own.
 *
 * Why the split is worth the extra file: a graph builder living inside a
 * component can only be tested by mounting it, which needs jsdom and a testing
 * library this repo does not install — so in practice it would not be tested at
 * all. Here, `bunx vitest run lib/ultraplan/graph.test.ts` covers layout,
 * status derivation and every edge rule with no DOM and no API key.
 *
 * Layout is deterministic by construction (fixed lanes, sorted rows, integer
 * arithmetic). No force simulation, no `Math.random`, no measured DOM: the same
 * input always produces the same coordinates, so the canvas does not rearrange
 * itself under the founder between two identical fetches.
 */

/** Lane order, left to right: what you know → who it is for → what you made → what is next. */
export const LANE_ORDER: readonly CanvasNodeType[] = [
  "fact",
  "persona",
  "artifact",
  "task",
] as const;

/**
 * Layout geometry, in the same coordinate space @xyflow/react uses (top-left
 * origin, y increasing downward), so swapping the renderer needs no
 * recalculation. LANE_WIDTH − NODE_WIDTH and ROW_HEIGHT − NODE_HEIGHT are the
 * gutters; the row gutter is generous because a task node carries an action row
 * the other three do not, and a node that overflows its row would overlap the
 * one below it in the absolutely-positioned stub renderer.
 */
export const NODE_WIDTH = 280;
export const LANE_WIDTH = 340;
export const ROW_HEIGHT = 148;
export const NODE_HEIGHT = 112;

/**
 * A stored fact at or above this confidence is treated as CONFIRMED; below it,
 * `provisional`. 70 is the extractor's "the founder said this plainly" band —
 * the point is only that there IS a threshold, so a 20%-confidence guess never
 * renders identically to something the founder stated outright.
 */
export const FACT_CONFIDENCE_CONFIRMED = 70;

const MIN_CONFIDENCE = 0;
const MAX_CONFIDENCE = 100;

// ─────────────────────────────────────────────────────────────────────────────
// Inputs. Deliberately plain shapes, NOT drizzle row types.
//
// lib/db/schema.ts is out of this module's reach on purpose: `persona` has no
// table yet (it arrives with Step 6) and tasks have no table at all, so binding
// to today's schema would either block this step or force a schema edit. Plain
// inputs also mean graph.test.ts constructs fixtures by hand instead of
// standing up a database.
// ─────────────────────────────────────────────────────────────────────────────

export type CanvasFactInput = {
  key: string;
  value: string;
  /** 0-100 as stored. NULL, NaN or out of range ⇒ node status "unknown". */
  confidence: number | null;
  /** Provenance: the phase that last wrote it. */
  phaseKey: string | null;
};

export type CanvasArtifactInput = {
  id: string;
  title: string;
  kind: string | null;
  /**
   * NULL means "we could not determine whether this artifact has content" and
   * renders as unknown. FALSE means we checked and it is empty.
   */
  hasContent: boolean | null;
  /** Fact keys the artifact cites. Each becomes an edge, or a reported drop. */
  citesFactKeys: string[];
};

export type CanvasPersonaInput = {
  id: string;
  name: string;
  summary: string | null;
  /**
   * Step 6 makes `evidence[]` mandatory on a persona. 0 is a real failure and
   * renders at-risk; NULL means we could not read the field and renders unknown.
   */
  evidenceCount: number | null;
  derivedFromFactKeys: string[];
};

export type BuildCanvasGraphInput = {
  analysis: BlockerAnalysis;
  /** Already reconciled against stored state by reconcileTasks(). */
  tasks: CanvasTask[];
  facts: CanvasFactInput[];
  artifacts: CanvasArtifactInput[];
  personas: CanvasPersonaInput[];
};

// ─────────────────────────────────────────────────────────────────────────────
// Node ids. Namespaced by type so a persona whose id equals a document id
// cannot collide — React would render one of them and silently drop the other.
// ─────────────────────────────────────────────────────────────────────────────

export function factNodeId(key: string): string {
  return `fact:${key}`;
}
export function artifactNodeId(id: string): string {
  return `artifact:${id}`;
}
export function personaNodeId(id: string): string {
  return `persona:${id}`;
}
export function taskNodeId(id: string): string {
  return `task:${id}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Status derivation. Every one of these returns "unknown" when the backing
// value is unreadable, and NONE of them can reach "confirmed" by default.
// ─────────────────────────────────────────────────────────────────────────────

function factStatus(fact: CanvasFactInput): CanvasNodeStatus {
  if (!fact.value.trim()) {
    return "unknown";
  }
  const confidence = fact.confidence;
  if (
    confidence === null ||
    !Number.isFinite(confidence) ||
    confidence < MIN_CONFIDENCE ||
    confidence > MAX_CONFIDENCE
  ) {
    // A confidence we cannot read is not a low confidence — it is no
    // information, and the node says so instead of picking a band.
    return "unknown";
  }
  return confidence >= FACT_CONFIDENCE_CONFIRMED ? "confirmed" : "provisional";
}

function artifactStatus(artifact: CanvasArtifactInput): CanvasNodeStatus {
  if (artifact.hasContent === null) {
    return "unknown";
  }
  return artifact.hasContent ? "confirmed" : "provisional";
}

function personaStatus(persona: CanvasPersonaInput): CanvasNodeStatus {
  const count = persona.evidenceCount;
  if (count === null || !Number.isFinite(count) || count < 0) {
    return "unknown";
  }
  // Zero evidence is not "thin", it is a persona nobody sourced — the exact
  // artefact the mandatory `evidence[]` of Step 6 exists to prevent. It renders
  // as a failure, not as a slightly paler success.
  return count === 0 ? "at-risk" : "confirmed";
}

/**
 * Task status, and the rule that makes the whole board honest:
 *
 * A TASK CANNOT CERTIFY ITSELF. Ticking a task is the founder ASSERTING they
 * did the work. The evidence is the gate re-running and no longer reporting the
 * blocker. So while the blocker behind a task still refuses advance, the node
 * stays `at-risk` no matter what the founder set — otherwise a founder can turn
 * the entire board green while the phase is still blocked, which is the same
 * class of lie as phase-rail.tsx painting an unassessed project red.
 */
function taskStatus(
  task: CanvasTask,
  blocksAdvance: boolean
): CanvasNodeStatus {
  if (task.state === "unknown") {
    return "unknown";
  }
  if (blocksAdvance) {
    return "at-risk";
  }
  if (task.state === "blocked") {
    return "at-risk";
  }
  if (task.state === "done") {
    return "confirmed";
  }
  // todo / active / dropped. A dropped task is explicitly NOT evidence of
  // anything, so it must never reach "confirmed"; the node renders its state
  // label, which is what tells those three apart on screen.
  return "provisional";
}

// ─────────────────────────────────────────────────────────────────────────────
// Build
// ─────────────────────────────────────────────────────────────────────────────

function truncatedSubtitle(value: string, max: number): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

const SUBTITLE_MAX = 120;

/**
 * Sort order within a lane.
 *
 * Facts, personas and artifacts are sorted by a stable natural key because SQL
 * makes NO promise about row order without an ORDER BY, and a canvas whose
 * nodes swap places between two identical fetches is unreadable. Tasks are the
 * exception: their order comes from analyzeBlockers(), is already deterministic,
 * and CARRIES MEANING (blocking gaps first) — re-sorting them alphabetically
 * would throw that away.
 */
function byKey<T>(items: T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => key(a).localeCompare(key(b)));
}

function laneX(type: CanvasNodeType): number {
  const index = LANE_ORDER.indexOf(type);
  // -1 is impossible for a CanvasNodeType, but clamping beats emitting NaN
  // coordinates that would stack every node at the origin.
  return (index < 0 ? LANE_ORDER.length : index) * LANE_WIDTH;
}

function position(type: CanvasNodeType, row: number) {
  return { x: laneX(type), y: row * ROW_HEIGHT };
}

function buildFactNodes(facts: CanvasFactInput[]): CanvasNode[] {
  return byKey(facts, (f) => f.key).map((fact, row) => {
    const status = factStatus(fact);
    return {
      type: "fact",
      id: factNodeId(fact.key),
      position: position("fact", row),
      title: fact.key,
      subtitle: truncatedSubtitle(fact.value, SUBTITLE_MAX),
      status,
      factKey: fact.key,
      // An unreadable confidence is surfaced as NULL rather than passed through
      // as a number the node would then render as if it meant something.
      confidence: status === "unknown" ? null : fact.confidence,
      phaseKey: fact.phaseKey,
    };
  });
}

function buildPersonaNodes(personas: CanvasPersonaInput[]): CanvasNode[] {
  return byKey(personas, (p) => `${p.name} ${p.id}`).map((persona, row) => ({
    type: "persona",
    id: personaNodeId(persona.id),
    position: position("persona", row),
    title: persona.name,
    subtitle: persona.summary
      ? truncatedSubtitle(persona.summary, SUBTITLE_MAX)
      : null,
    status: personaStatus(persona),
    personaId: persona.id,
    evidenceCount: persona.evidenceCount,
  }));
}

function buildArtifactNodes(artifacts: CanvasArtifactInput[]): CanvasNode[] {
  return byKey(artifacts, (a) => `${a.title} ${a.id}`).map((artifact, row) => ({
    type: "artifact",
    id: artifactNodeId(artifact.id),
    position: position("artifact", row),
    title: artifact.title,
    subtitle: artifact.kind,
    status: artifactStatus(artifact),
    documentId: artifact.id,
    kind: artifact.kind,
  }));
}

function buildTaskNodes(
  tasks: CanvasTask[],
  blockers: Blocker[]
): CanvasNode[] {
  const blocksAdvanceByCriterion = new Map(
    blockers.map((b) => [b.criterionId, b.blocksAdvance])
  );
  return tasks.map((task, row) => ({
    type: "task",
    id: taskNodeId(task.id),
    position: position("task", row),
    title: task.title,
    subtitle: truncatedSubtitle(task.detail, SUBTITLE_MAX),
    // An orphaned task has no live blocker, so `?? false` here is not a
    // fail-open guess: the blocker genuinely is not in the current verdict, and
    // reconcileTasks() has already flagged the task `orphaned` so the UI can
    // say so.
    status: taskStatus(
      task,
      blocksAdvanceByCriterion.get(task.criterionId) ?? false
    ),
    task,
  }));
}

type EdgeRequest = {
  source: string;
  target: string;
  kind: CanvasEdgeKind;
  /**
   * TRUE when a missing endpoint is a DEFECT worth reporting; FALSE when it is
   * the expected case. A `produces` edge to a fact that does not exist yet is
   * the normal state of an unblocking task — the fact is missing BECAUSE the
   * task is outstanding — so it is skipped without being reported, and the task
   * node still names its target via `producesFactKey`.
   */
  reportIfMissing: boolean;
};

function collectEdgeRequests(input: BuildCanvasGraphInput): EdgeRequest[] {
  const requests: EdgeRequest[] = [];
  for (const artifact of input.artifacts) {
    for (const key of artifact.citesFactKeys) {
      requests.push({
        source: artifactNodeId(artifact.id),
        target: factNodeId(key),
        kind: "cites",
        reportIfMissing: true,
      });
    }
  }
  for (const persona of input.personas) {
    for (const key of persona.derivedFromFactKeys) {
      requests.push({
        source: personaNodeId(persona.id),
        target: factNodeId(key),
        kind: "derived-from",
        reportIfMissing: true,
      });
    }
  }
  for (const task of input.tasks) {
    if (task.producesFactKey === null) {
      continue;
    }
    requests.push({
      source: taskNodeId(task.id),
      target: factNodeId(task.producesFactKey),
      kind: "produces",
      reportIfMissing: false,
    });
  }
  return requests;
}

/**
 * THE PURE ENTRY POINT. Everything the canvas draws, decided without a DOM.
 *
 * Fail-closed properties asserted in graph.test.ts:
 *  • every node's status defaults to "unknown" when its backing value is
 *    unreadable, and no path reaches "confirmed" by default;
 *  • no edge ever references a node id that is not in `nodes`;
 *  • an edge whose endpoint is missing AND whose absence is a defect appears in
 *    `droppedEdges` with a reason — it is never silently omitted;
 *  • `assessment` is carried straight through from the analysis, so an
 *    unassessed project is "unassessed" on the canvas, never "blocked".
 */
export function buildCanvasGraph(input: BuildCanvasGraphInput): CanvasGraph {
  const nodes: CanvasNode[] = [
    ...buildFactNodes(input.facts),
    ...buildPersonaNodes(input.personas),
    ...buildArtifactNodes(input.artifacts),
    ...buildTaskNodes(input.tasks, input.analysis.blockers),
  ];

  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges: CanvasEdge[] = [];
  const droppedEdges: DroppedEdge[] = [];
  const seenEdgeIds = new Set<string>();

  for (const request of collectEdgeRequests(input)) {
    const { source, target, kind } = request;
    const missing: string[] = [];
    if (!nodeIds.has(source)) {
      missing.push(`source "${source}"`);
    }
    if (!nodeIds.has(target)) {
      missing.push(`target "${target}"`);
    }
    if (missing.length > 0) {
      if (request.reportIfMissing) {
        droppedEdges.push({
          source,
          target,
          kind,
          reason: `${missing.join(" and ")} is not on the canvas`,
        });
      }
      continue;
    }
    const id = `${kind}:${source}->${target}`;
    // Two artifacts citing the same fact are two edges; ONE artifact citing the
    // same fact twice is one. Duplicate ids would collide as React keys.
    if (seenEdgeIds.has(id)) {
      continue;
    }
    seenEdgeIds.add(id);
    edges.push({ id, source, target, kind });
  }

  return {
    nodes,
    edges,
    assessment: input.analysis.state,
    droppedEdges,
  };
}

/**
 * Bounding box of the laid-out graph, for a surface that has to size a scroll
 * area before anything is measured. Empty graph ⇒ zero size, not NaN.
 */
export function graphBounds(graph: CanvasGraph): {
  width: number;
  height: number;
} {
  let width = 0;
  let height = 0;
  for (const node of graph.nodes) {
    width = Math.max(width, node.position.x + NODE_WIDTH);
    height = Math.max(height, node.position.y + NODE_HEIGHT);
  }
  return { width, height };
}
