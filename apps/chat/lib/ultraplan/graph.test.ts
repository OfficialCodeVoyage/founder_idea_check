import { describe, expect, it } from "vitest";
import {
  type BuildCanvasGraphInput,
  buildCanvasGraph,
  type CanvasArtifactInput,
  type CanvasFactInput,
  type CanvasPersonaInput,
  factNodeId,
  graphBounds,
  LANE_ORDER,
  LANE_WIDTH,
  ROW_HEIGHT,
} from "./graph";
import type { Blocker, BlockerAnalysis, CanvasNode, CanvasTask } from "./types";

const HIGH_CONFIDENCE = 90;
const LOW_CONFIDENCE = 30;
const IMPOSSIBLE_CONFIDENCE = 150;

function analysis(overrides: Partial<BlockerAnalysis> = {}): BlockerAnalysis {
  return {
    state: overrides.state ?? "unassessed",
    decision: overrides.decision ?? null,
    blockers: overrides.blockers ?? [],
    tasks: overrides.tasks ?? [],
    reason: overrides.reason ?? null,
  };
}

function blocker(criterionId: string, blocksAdvance: boolean): Blocker {
  return {
    id: `phase-one::${criterionId}`,
    criterionId,
    blocker: `${criterionId} is missing`,
    severity: blocksAdvance ? "blocking" : "advisory",
    blocksAdvance,
    status: "unmet",
    unblockingTasks: [],
  };
}

function canvasTask(overrides: Partial<CanvasTask> = {}): CanvasTask {
  return {
    id: overrides.id ?? "phase-one::problem-statement::establish-fact",
    kind: overrides.kind ?? "establish-fact",
    title: overrides.title ?? 'Establish "problem_statement"',
    detail: overrides.detail ?? "A one-sentence problem statement.",
    criterionId: overrides.criterionId ?? "problem-statement",
    producesFactKey:
      overrides.producesFactKey === undefined
        ? "problem_statement"
        : overrides.producesFactKey,
    state: overrides.state ?? "todo",
    orphaned: overrides.orphaned ?? false,
  };
}

function fact(overrides: Partial<CanvasFactInput> = {}): CanvasFactInput {
  return {
    key: overrides.key ?? "problem_statement",
    value: overrides.value ?? "Dog owners forget vaccination dates.",
    confidence:
      overrides.confidence === undefined
        ? HIGH_CONFIDENCE
        : overrides.confidence,
    phaseKey: overrides.phaseKey ?? "problem-validation",
  };
}

function persona(
  overrides: Partial<CanvasPersonaInput> = {}
): CanvasPersonaInput {
  return {
    id: overrides.id ?? "p1",
    name: overrides.name ?? "Weekend dog owner",
    summary: overrides.summary ?? null,
    evidenceCount:
      overrides.evidenceCount === undefined ? 3 : overrides.evidenceCount,
    derivedFromFactKeys: overrides.derivedFromFactKeys ?? [],
  };
}

function artifact(
  overrides: Partial<CanvasArtifactInput> = {}
): CanvasArtifactInput {
  return {
    id: overrides.id ?? "d1",
    title: overrides.title ?? "Problem brief",
    kind: overrides.kind ?? "text",
    hasContent:
      overrides.hasContent === undefined ? true : overrides.hasContent,
    citesFactKeys: overrides.citesFactKeys ?? [],
  };
}

function build(
  overrides: Partial<BuildCanvasGraphInput> = {}
): ReturnType<typeof buildCanvasGraph> {
  return buildCanvasGraph({
    analysis: overrides.analysis ?? analysis(),
    tasks: overrides.tasks ?? [],
    facts: overrides.facts ?? [],
    artifacts: overrides.artifacts ?? [],
    personas: overrides.personas ?? [],
  });
}

function nodeById(nodes: CanvasNode[], id: string): CanvasNode {
  const found = nodes.find((n) => n.id === id);
  if (!found) {
    throw new Error(`no node ${id}`);
  }
  return found;
}

describe("buildCanvasGraph — layout", () => {
  it("puts each node type in its own lane", () => {
    const graph = build({
      facts: [fact()],
      personas: [persona()],
      artifacts: [artifact()],
      tasks: [canvasTask()],
    });
    for (const node of graph.nodes) {
      expect(node.position.x).toBe(LANE_ORDER.indexOf(node.type) * LANE_WIDTH);
    }
  });

  it("sorts facts by key so a re-fetch cannot reshuffle the board", () => {
    // SQL promises nothing about row order without an ORDER BY.
    const forward = build({
      facts: [fact({ key: "a_key" }), fact({ key: "z_key" })],
    });
    const reversed = build({
      facts: [fact({ key: "z_key" }), fact({ key: "a_key" })],
    });
    expect(forward.nodes.map((n) => n.id)).toEqual([
      "fact:a_key",
      "fact:z_key",
    ]);
    expect(reversed.nodes.map((n) => n.id)).toEqual(
      forward.nodes.map((n) => n.id)
    );
    expect(forward.nodes[0].position.y).toBe(0);
    expect(forward.nodes[1].position.y).toBe(ROW_HEIGHT);
  });

  it("keeps task order exactly as analyzeBlockers produced it", () => {
    // Task order is blocking-first and therefore carries meaning; sorting it
    // alphabetically would discard that.
    const graph = build({
      tasks: [
        canvasTask({ id: "z-task", title: "Z" }),
        canvasTask({ id: "a-task", title: "A" }),
      ],
    });
    expect(graph.nodes.map((n) => n.id)).toEqual([
      "task:z-task",
      "task:a-task",
    ]);
  });

  it("is a total function of its input", () => {
    const input: Partial<BuildCanvasGraphInput> = {
      facts: [fact(), fact({ key: "target_user", value: "vets" })],
      personas: [persona()],
      artifacts: [artifact()],
      tasks: [canvasTask()],
    };
    expect(build(input)).toEqual(build(input));
  });

  it("reports zero bounds for an empty graph rather than NaN", () => {
    expect(graphBounds(build())).toEqual({ width: 0, height: 0 });
  });
});

describe("buildCanvasGraph — status derivation fails closed", () => {
  it("marks a high-confidence fact confirmed and a low-confidence one provisional", () => {
    const graph = build({
      facts: [
        fact({ key: "a", confidence: HIGH_CONFIDENCE }),
        fact({ key: "b", confidence: LOW_CONFIDENCE }),
      ],
    });
    expect(nodeById(graph.nodes, factNodeId("a")).status).toBe("confirmed");
    expect(nodeById(graph.nodes, factNodeId("b")).status).toBe("provisional");
  });

  it("renders an unreadable confidence as unknown, never as a band", () => {
    const graph = build({
      facts: [
        fact({ key: "a", confidence: null }),
        fact({ key: "b", confidence: IMPOSSIBLE_CONFIDENCE }),
        fact({ key: "c", confidence: Number.NaN }),
        fact({ key: "d", value: "   " }),
      ],
    });
    for (const key of ["a", "b", "c", "d"]) {
      expect(nodeById(graph.nodes, factNodeId(key)).status).toBe("unknown");
    }
    const node = nodeById(graph.nodes, factNodeId("b"));
    // The unusable number is not passed through to be rendered as if it meant
    // something.
    expect(node.type === "fact" && node.confidence).toBeNull();
  });

  it("renders a persona with zero evidence as at-risk and one with none read as unknown", () => {
    const graph = build({
      personas: [
        persona({ id: "none", evidenceCount: 0 }),
        persona({ id: "unread", evidenceCount: null }),
        persona({ id: "sourced", evidenceCount: 2 }),
      ],
    });
    expect(nodeById(graph.nodes, "persona:none").status).toBe("at-risk");
    expect(nodeById(graph.nodes, "persona:unread").status).toBe("unknown");
    expect(nodeById(graph.nodes, "persona:sourced").status).toBe("confirmed");
  });

  it("renders an artifact whose content could not be read as unknown", () => {
    const graph = build({
      artifacts: [
        artifact({ id: "unread", hasContent: null }),
        artifact({ id: "empty", hasContent: false }),
        artifact({ id: "full", hasContent: true }),
      ],
    });
    expect(nodeById(graph.nodes, "artifact:unread").status).toBe("unknown");
    expect(nodeById(graph.nodes, "artifact:empty").status).toBe("provisional");
    expect(nodeById(graph.nodes, "artifact:full").status).toBe("confirmed");
  });
});

describe("buildCanvasGraph — a task cannot certify itself", () => {
  it("keeps a task at-risk while its blocker still refuses advance, even when ticked", () => {
    // Otherwise a founder can turn the whole board green while the gate is
    // still blocking the phase.
    const graph = build({
      analysis: analysis({
        state: "blocked",
        decision: "BLOCK",
        blockers: [blocker("problem-statement", true)],
      }),
      tasks: [canvasTask({ state: "done" })],
    });
    expect(graph.nodes[0].status).toBe("at-risk");
  });

  it("confirms a done task once nothing is blocking on its criterion", () => {
    const graph = build({
      analysis: analysis({ state: "advisory", decision: "WARN" }),
      tasks: [canvasTask({ state: "done" })],
    });
    expect(graph.nodes[0].status).toBe("confirmed");
  });

  it("renders an unreadable task state as unknown before anything else", () => {
    const graph = build({
      analysis: analysis({
        state: "blocked",
        decision: "BLOCK",
        blockers: [blocker("problem-statement", true)],
      }),
      tasks: [canvasTask({ state: "unknown" })],
    });
    expect(graph.nodes[0].status).toBe("unknown");
  });

  it("never renders a dropped task as confirmed", () => {
    const graph = build({ tasks: [canvasTask({ state: "dropped" })] });
    expect(graph.nodes[0].status).toBe("provisional");
  });
});

describe("buildCanvasGraph — edges", () => {
  it("connects an artifact to the fact it cites", () => {
    const graph = build({
      facts: [fact({ key: "problem_statement" })],
      artifacts: [artifact({ citesFactKeys: ["problem_statement"] })],
    });
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({
      source: "artifact:d1",
      target: "fact:problem_statement",
      kind: "cites",
    });
    expect(graph.droppedEdges).toEqual([]);
  });

  it("reports — never silently omits — a citation to a fact that is not there", () => {
    const graph = build({
      artifacts: [artifact({ citesFactKeys: ["ghost_fact"] })],
    });
    expect(graph.edges).toEqual([]);
    expect(graph.droppedEdges).toHaveLength(1);
    expect(graph.droppedEdges[0].reason).toContain("fact:ghost_fact");
  });

  it("reports a persona derived from a fact that is not there", () => {
    const graph = build({
      personas: [persona({ derivedFromFactKeys: ["ghost_fact"] })],
    });
    expect(graph.droppedEdges).toHaveLength(1);
    expect(graph.droppedEdges[0].kind).toBe("derived-from");
  });

  it("draws a produces edge only when the target fact already exists", () => {
    const withFact = build({
      facts: [fact({ key: "problem_statement" })],
      tasks: [canvasTask()],
    });
    expect(withFact.edges).toHaveLength(1);
    expect(withFact.edges[0].kind).toBe("produces");
  });

  it("does not report a produces edge to a fact the task exists to create", () => {
    // The fact is missing BECAUSE the task is outstanding. Reporting that as a
    // dropped edge would fill the defect list with the normal case.
    const graph = build({ tasks: [canvasTask()] });
    expect(graph.edges).toEqual([]);
    expect(graph.droppedEdges).toEqual([]);
  });

  it("deduplicates a repeated relation so React keys cannot collide", () => {
    const graph = build({
      facts: [fact({ key: "problem_statement" })],
      artifacts: [
        artifact({
          citesFactKeys: ["problem_statement", "problem_statement"],
        }),
      ],
    });
    expect(graph.edges).toHaveLength(1);
  });

  it("never emits an edge that points at a node it did not build", () => {
    const graph = build({
      facts: [fact({ key: "problem_statement" }), fact({ key: "target_user" })],
      personas: [persona({ derivedFromFactKeys: ["target_user", "nope"] })],
      artifacts: [artifact({ citesFactKeys: ["problem_statement", "nope"] })],
      tasks: [canvasTask(), canvasTask({ id: "t2", producesFactKey: "nope" })],
    });
    const ids = new Set(graph.nodes.map((n) => n.id));
    for (const edge of graph.edges) {
      expect(ids.has(edge.source)).toBe(true);
      expect(ids.has(edge.target)).toBe(true);
    }
  });
});

describe("buildCanvasGraph — assessment passthrough", () => {
  it("carries 'unassessed' onto the canvas instead of collapsing it to blocked", () => {
    expect(build().assessment).toBe("unassessed");
  });

  it("carries every other assessment state through untouched", () => {
    for (const state of ["clear", "advisory", "blocked"] as const) {
      expect(build({ analysis: analysis({ state }) }).assessment).toBe(state);
    }
  });
});
