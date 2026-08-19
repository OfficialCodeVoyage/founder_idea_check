import {
  type CanvasTask,
  type StoredTask,
  StoredTaskSchema,
  TASK_EVENTS,
  TASK_STATES,
  type TaskEvent,
  type TaskState,
  type UnblockingTask,
} from "./types";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ULTRAPLAN — THE TASK STATE MACHINE. PURE, TOTAL, AND IT NEVER THROWS.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Same discipline as gate.ts's pure half: no I/O, no clock, no randomness, so
 * the whole file runs under vitest with every AI key unset. It also never
 * throws — a UI double-click, a stale optimistic update, or a row written by an
 * older build must produce a REFUSAL VALUE the caller can render, not an
 * exception that unmounts the canvas.
 *
 * The two rules everything else follows from:
 *
 *  1. NOTHING REACHES "done" BY DEFAULT. `done` is only ever the target of an
 *     explicit `complete` event from a state where completing is meaningful.
 *     Every parse failure, every unreadable row, every unrecognised state lands
 *     on `unknown` instead — which renders as unknown and blocks nothing.
 *
 *  2. SILENCE IS NOT COMPLETION. A task whose blocker vanishes from the current
 *     verdict is marked `orphaned`, never auto-completed. gate.ts's fail-closed
 *     paths (failClosedVerdict, the coverage-mismatch branch) emit verdicts that
 *     mention FEWER criteria than the phase defines — so "the gate stopped
 *     mentioning it" is a signal that the gate got confused at least as often as
 *     it is a signal that the founder fixed something.
 */

const KNOWN_TASK_STATES = new Set<string>(TASK_STATES);

/**
 * Fail-closed parse for a state string read back out of storage.
 *
 * Anything unrecognised — a typo, a state from a future build, a number, null —
 * becomes "unknown". Normalising to "todo" instead would be the friendlier
 * guess and the wrong one: it would silently rewrite a row we failed to read,
 * turning a persistence bug into invisible data loss.
 */
export function parseTaskState(raw: unknown): TaskState {
  if (typeof raw === "string" && KNOWN_TASK_STATES.has(raw)) {
    return raw as TaskState;
  }
  return "unknown";
}

/**
 * THE TRANSITION TABLE. Absence from this table means REFUSED, so adding a new
 * state cannot accidentally inherit permissive behaviour from a fallthrough.
 *
 * Self-transitions are listed EXPLICITLY (todo+unblock, active+start,
 * blocked+block, done+complete, dropped+drop) so that a repeated event — the
 * double-click, the replayed optimistic update — is an idempotent no-op with
 * `changed: false` rather than a refusal the UI has to explain away. Only
 * transitions that are genuinely meaningless are missing.
 */
const TRANSITIONS: Record<TaskState, Partial<Record<TaskEvent, TaskState>>> = {
  /**
   * The parse-failure state. The ONLY ways out are explicit human
   * reclassification (`reopen`) or explicit dismissal (`drop`). In particular
   * there is no `complete` — a task we could not read is not a task we may
   * declare finished.
   */
  unknown: { reopen: "todo", drop: "dropped" },
  todo: {
    start: "active",
    block: "blocked",
    complete: "done",
    drop: "dropped",
    unblock: "todo",
    reopen: "todo",
  },
  active: {
    start: "active",
    complete: "done",
    block: "blocked",
    reopen: "todo",
    drop: "dropped",
  },
  /**
   * No `complete` and no `start`. Completing a blocked task is how a blocker
   * disappears from the board while still being true — the founder marks the
   * task done, the canvas goes green, and the thing that actually stopped
   * progress is now invisible. Unblock it first, on purpose.
   */
  blocked: { block: "blocked", unblock: "todo", drop: "dropped" },
  /** Reversible, but not droppable: dropping finished work loses the record. */
  done: { complete: "done", reopen: "todo" },
  dropped: { drop: "dropped", restore: "todo" },
};

export type TaskTransition =
  | { ok: true; state: TaskState; changed: boolean }
  | { ok: false; state: TaskState; reason: string };

/** Named refusals for the moves whose refusal carries a product rule. */
const REFUSALS: Partial<Record<`${TaskState}:${TaskEvent}`, string>> = {
  "blocked:complete":
    "a blocked task cannot be completed — unblock it first, or completing it hides the blocker",
  "blocked:start":
    "a blocked task cannot be started — resolve or clear the block first",
  "unknown:complete":
    "this task's stored state could not be read, so it cannot be marked done — reopen it first",
  "unknown:start":
    "this task's stored state could not be read — reopen it before working on it",
  "done:drop": "a completed task cannot be dropped — reopen it first",
  "dropped:complete":
    "a dropped task cannot be completed — restore it first if it applies after all",
};

/**
 * Apply one event. Returns a value in every case; never throws.
 *
 * `changed: false` means "already there" (idempotent replay). `ok: false` means
 * the move is refused and the state is UNCHANGED — the caller renders the
 * reason rather than silently doing nothing, which is the difference between a
 * rule and a bug.
 */
export function applyTaskEvent(
  state: TaskState,
  event: TaskEvent
): TaskTransition {
  const target = TRANSITIONS[state][event];
  if (target === undefined) {
    return {
      ok: false,
      state,
      reason:
        REFUSALS[`${state}:${event}`] ??
        `"${event}" is not a legal move from "${state}"`,
    };
  }
  return { ok: true, state: target, changed: target !== state };
}

/** Open = still demands work. `unknown` counts as open: we cannot say it doesn't. */
export function isOpenTask(state: TaskState): boolean {
  return state !== "done" && state !== "dropped";
}

/**
 * The events a UI should OFFER for a given state: legal, and actually a change.
 *
 * Derived from the same table applyTaskEvent() uses rather than hand-written in
 * the component, because a hand-written button list is how a UI ends up
 * offering "Mark done" on a blocked task — the click is refused, and from the
 * founder's side the app simply does not work. Idempotent self-transitions are
 * excluded: a "Start" button on an already-active task is a dead control.
 */
export function availableTaskEvents(state: TaskState): TaskEvent[] {
  return TASK_EVENTS.filter((event) => {
    const result = applyTaskEvent(state, event);
    return result.ok && result.changed;
  });
}

/**
 * Parse the persisted task list out of a `json` column, which is genuinely
 * `unknown`. Rows that cannot be read are COUNTED, not swallowed — a canvas
 * quietly showing three of a founder's five tasks is worse than one showing
 * three plus "2 stored tasks could not be read".
 */
export function parseStoredTasks(raw: unknown): {
  tasks: StoredTask[];
  dropped: number;
} {
  if (!Array.isArray(raw)) {
    // Not "0 rows dropped from a list of 0" — this is a shape we do not
    // recognise at all, and pretending to have counted it would be a lie. The
    // caller sees an empty list, which renders as "no tasks yet".
    return { tasks: [], dropped: 0 };
  }
  const tasks: StoredTask[] = [];
  let dropped = 0;
  for (const entry of raw) {
    const parsed = StoredTaskSchema.safeParse(entry);
    if (parsed.success) {
      tasks.push(parsed.data);
    } else {
      // The only field without a `.catch()` fallback is `id`, and a task with
      // no id cannot be matched to anything or keyed in React.
      dropped += 1;
    }
  }
  return { tasks, dropped };
}

const UNREADABLE_TITLE_PREFIX = "Unreadable stored task";

/**
 * Merge the tasks the CURRENT verdict generates with the states a founder has
 * already set.
 *
 * Who wins what, and why:
 *  • the generated task wins on WORDING (title, detail, target). The gate's
 *    current sentence is the truth about what is missing now; a stale snapshot
 *    would keep showing a gap in last week's words.
 *  • storage wins on STATE. That is the only field the founder owns, and
 *    regenerating it from the verdict would throw away their work every turn.
 *  • a stored task with no matching generated task is kept and flagged
 *    `orphaned` — see rule 2 in the file header. It is never auto-completed and
 *    never dropped.
 */
export function reconcileTasks(
  generated: UnblockingTask[],
  stored: StoredTask[]
): CanvasTask[] {
  const storedById = new Map(stored.map((s) => [s.id, s]));
  const generatedIds = new Set(generated.map((t) => t.id));

  const tasks: CanvasTask[] = generated.map((task) => ({
    ...task,
    // No stored row means the verdict just produced this task: "todo", not
    // "unknown". We know exactly what it is — nobody has touched it yet.
    state: storedById.has(task.id)
      ? parseTaskState(storedById.get(task.id)?.state)
      : "todo",
    orphaned: false,
  }));

  for (const row of stored) {
    if (generatedIds.has(row.id)) {
      continue;
    }
    tasks.push({
      id: row.id,
      kind: "close-gap",
      // A blank title means the row lost its snapshot. Render it LOUDLY rather
      // than dropping it: an unreadable task the founder can see and dismiss
      // beats one that silently disappears from the board.
      title: row.title.trim() || `${UNREADABLE_TITLE_PREFIX} (${row.id})`,
      detail: row.detail,
      criterionId: row.criterionId,
      producesFactKey: row.producesFactKey,
      state: parseTaskState(row.state),
      orphaned: true,
    });
  }

  return tasks;
}

export type TaskSummary = {
  total: number;
  open: number;
  done: number;
  blocked: number;
  /** Rows whose state could not be read. Shown, never rounded away. */
  unknown: number;
  orphaned: number;
};

export function summarizeTasks(tasks: CanvasTask[]): TaskSummary {
  const summary: TaskSummary = {
    total: tasks.length,
    open: 0,
    done: 0,
    blocked: 0,
    unknown: 0,
    orphaned: 0,
  };
  for (const task of tasks) {
    if (isOpenTask(task.state)) {
      summary.open += 1;
    }
    if (task.state === "done") {
      summary.done += 1;
    }
    if (task.state === "blocked") {
      summary.blocked += 1;
    }
    if (task.state === "unknown") {
      summary.unknown += 1;
    }
    if (task.orphaned) {
      summary.orphaned += 1;
    }
  }
  return summary;
}
