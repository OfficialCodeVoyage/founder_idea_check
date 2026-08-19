import { describe, expect, it } from "vitest";
import {
  applyTaskEvent,
  availableTaskEvents,
  isOpenTask,
  parseStoredTasks,
  parseTaskState,
  reconcileTasks,
  summarizeTasks,
} from "./tasks";
import {
  type CanvasTask,
  type StoredTask,
  TASK_EVENTS,
  TASK_STATES,
  type TaskState,
  type UnblockingTask,
} from "./types";

function task(overrides: Partial<UnblockingTask> = {}): UnblockingTask {
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
  };
}

function stored(overrides: Partial<StoredTask> = {}): StoredTask {
  return {
    id: overrides.id ?? "phase-one::problem-statement::establish-fact",
    state: overrides.state ?? "active",
    title: overrides.title ?? "stale title",
    detail: overrides.detail ?? "stale detail",
    criterionId: overrides.criterionId ?? "problem-statement",
    producesFactKey:
      overrides.producesFactKey === undefined
        ? "problem_statement"
        : overrides.producesFactKey,
  };
}

function canvasTask(state: TaskState, orphaned = false): CanvasTask {
  return { ...task(), state, orphaned };
}

describe("parseTaskState — fails closed", () => {
  it("accepts every state it declares", () => {
    for (const state of TASK_STATES) {
      expect(parseTaskState(state)).toBe(state);
    }
  });

  it("normalises anything unrecognised to 'unknown', never to 'todo' or 'done'", () => {
    for (const raw of [
      "",
      "DONE",
      "complete",
      "in_progress",
      3,
      null,
      undefined,
      {},
    ]) {
      expect(parseTaskState(raw)).toBe("unknown");
    }
  });
});

describe("applyTaskEvent — the transition table", () => {
  it("never throws, whatever state/event pair it is handed", () => {
    for (const state of TASK_STATES) {
      for (const event of TASK_EVENTS) {
        expect(() => applyTaskEvent(state, event)).not.toThrow();
      }
    }
  });

  it("leaves the state untouched on every refusal", () => {
    for (const state of TASK_STATES) {
      for (const event of TASK_EVENTS) {
        const result = applyTaskEvent(state, event);
        if (!result.ok) {
          expect(result.state).toBe(state);
          expect(result.reason.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("reaches 'done' ONLY through an explicit complete event", () => {
    // The single most important property in this file: nothing arrives at
    // "done" by default, by fallthrough, or by any event other than `complete`.
    for (const state of TASK_STATES) {
      for (const event of TASK_EVENTS) {
        const result = applyTaskEvent(state, event);
        if (result.ok && result.state === "done") {
          expect(event).toBe("complete");
        }
      }
    }
  });

  it("walks todo → active → done", () => {
    const started = applyTaskEvent("todo", "start");
    expect(started).toEqual({ ok: true, state: "active", changed: true });
    const done = applyTaskEvent("active", "complete");
    expect(done).toEqual({ ok: true, state: "done", changed: true });
  });

  it("refuses to complete a blocked task", () => {
    // Completing a blocked task is how a blocker disappears from the board
    // while still being true.
    const result = applyTaskEvent("blocked", "complete");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("unblock it first");
    }
  });

  it("refuses to complete or start a task whose stored state could not be read", () => {
    expect(applyTaskEvent("unknown", "complete").ok).toBe(false);
    expect(applyTaskEvent("unknown", "start").ok).toBe(false);
    // The only ways out of the parse-failure state are explicit.
    expect(applyTaskEvent("unknown", "reopen")).toEqual({
      ok: true,
      state: "todo",
      changed: true,
    });
    expect(applyTaskEvent("unknown", "drop")).toEqual({
      ok: true,
      state: "dropped",
      changed: true,
    });
  });

  it("treats a repeated event as an idempotent no-op, not a refusal", () => {
    // The double-click / replayed optimistic update path.
    expect(applyTaskEvent("active", "start")).toEqual({
      ok: true,
      state: "active",
      changed: false,
    });
    expect(applyTaskEvent("done", "complete")).toEqual({
      ok: true,
      state: "done",
      changed: false,
    });
    expect(applyTaskEvent("blocked", "block")).toEqual({
      ok: true,
      state: "blocked",
      changed: false,
    });
    expect(applyTaskEvent("dropped", "drop")).toEqual({
      ok: true,
      state: "dropped",
      changed: false,
    });
  });

  it("keeps done and dropped reversible in exactly one direction each", () => {
    expect(applyTaskEvent("done", "reopen").ok).toBe(true);
    expect(applyTaskEvent("done", "drop").ok).toBe(false);
    expect(applyTaskEvent("dropped", "restore").ok).toBe(true);
    expect(applyTaskEvent("dropped", "complete").ok).toBe(false);
  });

  it("counts unknown as open — we cannot claim it is finished", () => {
    expect(isOpenTask("unknown")).toBe(true);
    expect(isOpenTask("todo")).toBe(true);
    expect(isOpenTask("active")).toBe(true);
    expect(isOpenTask("blocked")).toBe(true);
    expect(isOpenTask("done")).toBe(false);
    expect(isOpenTask("dropped")).toBe(false);
  });
});

describe("availableTaskEvents — what the UI is allowed to offer", () => {
  it("only ever offers moves that would succeed and change something", () => {
    for (const state of TASK_STATES) {
      for (const event of availableTaskEvents(state)) {
        const result = applyTaskEvent(state, event);
        expect(result.ok).toBe(true);
        expect(result.ok && result.changed).toBe(true);
      }
    }
  });

  it("never offers to complete a blocked or unreadable task", () => {
    // A "Mark done" button whose click is refused reads to the founder as an
    // app that does not work.
    expect(availableTaskEvents("blocked")).not.toContain("complete");
    expect(availableTaskEvents("unknown")).not.toContain("complete");
  });

  it("offers exactly the two explicit escapes from the unreadable state", () => {
    expect(availableTaskEvents("unknown")).toEqual(["reopen", "drop"]);
  });
});

describe("parseStoredTasks — reading a json column", () => {
  it("returns nothing for a shape it does not recognise", () => {
    expect(parseStoredTasks(null)).toEqual({ tasks: [], dropped: 0 });
    expect(parseStoredTasks({ tasks: [] })).toEqual({ tasks: [], dropped: 0 });
    expect(parseStoredTasks("[]")).toEqual({ tasks: [], dropped: 0 });
  });

  it("survives partial corruption instead of losing the whole list", () => {
    const result = parseStoredTasks([
      { id: "a", state: "active", title: "t", detail: "d", criterionId: "c" },
      { id: "b", state: 42, title: null },
      { id: "c" },
    ]);
    expect(result.tasks).toHaveLength(3);
    expect(result.dropped).toBe(0);
    // A wrong-typed state survives parsing and is normalised later, rather than
    // taking the row with it.
    expect(parseTaskState(result.tasks[1].state)).toBe("unknown");
    expect(result.tasks[1].title).toBe("");
  });

  it("counts rows it cannot key, rather than silently shortening the list", () => {
    const result = parseStoredTasks([
      { id: "a" },
      { state: "done" },
      { id: "" },
    ]);
    expect(result.tasks).toHaveLength(1);
    expect(result.dropped).toBe(2);
  });
});

describe("reconcileTasks — generated wording, stored state", () => {
  it("keeps the founder's state and the gate's current wording", () => {
    const [merged] = reconcileTasks([task()], [stored({ state: "active" })]);
    expect(merged.state).toBe("active");
    expect(merged.title).toBe('Establish "problem_statement"');
    expect(merged.detail).toBe("A one-sentence problem statement.");
    expect(merged.orphaned).toBe(false);
  });

  it("starts a freshly generated task at 'todo', not at 'unknown'", () => {
    // Nobody has touched it — that is a known state, not an unreadable one.
    const [merged] = reconcileTasks([task()], []);
    expect(merged.state).toBe("todo");
  });

  it("fails closed on an unreadable stored state", () => {
    const [merged] = reconcileTasks([task()], [stored({ state: "finished" })]);
    expect(merged.state).toBe("unknown");
  });

  it("keeps a task whose blocker vanished, flagged and NOT auto-completed", () => {
    // The gate falling silent about a criterion is at least as often a
    // coverage failure as it is a fix.
    const merged = reconcileTasks(
      [],
      [stored({ id: "gone", state: "active", title: "Interview 5 users" })]
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].orphaned).toBe(true);
    expect(merged[0].state).toBe("active");
    expect(merged[0].state).not.toBe("done");
    expect(merged[0].title).toBe("Interview 5 users");
  });

  it("renders an orphan that lost its snapshot loudly rather than dropping it", () => {
    const merged = reconcileTasks([], [stored({ id: "gone", title: "  " })]);
    expect(merged).toHaveLength(1);
    expect(merged[0].title).toContain("Unreadable stored task");
    expect(merged[0].title).toContain("gone");
  });

  it("is deterministic: generated order first, then orphans in stored order", () => {
    const generated = [task({ id: "t1" }), task({ id: "t2" })];
    const rows = [
      stored({ id: "t2" }),
      stored({ id: "z" }),
      stored({ id: "y" }),
    ];
    expect(reconcileTasks(generated, rows).map((t) => t.id)).toEqual([
      "t1",
      "t2",
      "z",
      "y",
    ]);
  });
});

describe("summarizeTasks", () => {
  it("counts unknown rows instead of rounding them into a known bucket", () => {
    const summary = summarizeTasks([
      canvasTask("todo"),
      canvasTask("active"),
      canvasTask("blocked"),
      canvasTask("done"),
      canvasTask("dropped"),
      canvasTask("unknown"),
      canvasTask("todo", true),
    ]);
    expect(summary).toEqual({
      total: 7,
      open: 5,
      done: 1,
      blocked: 1,
      unknown: 1,
      orphaned: 1,
    });
  });
});
