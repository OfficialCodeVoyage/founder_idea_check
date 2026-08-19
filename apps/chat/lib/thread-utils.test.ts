import { describe, expect, it } from "vitest";
import { type MessageNode, selectActiveThread } from "./thread-utils";

type Node = MessageNode & { role: "user" | "assistant" };

let clock = 0;

function node(
  id: string,
  role: Node["role"],
  parentMessageId: string | null,
  extra: Partial<NonNullable<MessageNode["metadata"]>> = {}
): Node {
  clock += 1000;
  return {
    id,
    role,
    metadata: {
      parentMessageId,
      createdAt: new Date(clock),
      ...extra,
    },
  };
}

function ids(nodes: Node[]): string[] {
  return nodes.map((n) => n.id);
}

describe("selectActiveThread", () => {
  it("returns an empty thread for no messages", () => {
    expect(selectActiveThread([])).toEqual([]);
  });

  it("passes a linear conversation through unchanged", () => {
    const messages = [
      node("u1", "user", null),
      node("a1", "assistant", "u1"),
      node("u2", "user", "a1"),
      node("a2", "assistant", "u2"),
    ];
    expect(ids(selectActiveThread(messages))).toEqual(["u1", "a1", "u2", "a2"]);
  });

  it("drops the abandoned branch when a user message is edited", () => {
    // u2 was sent, answered, then EDITED into u2b. Both rows survive so the
    // branch switcher works. Flattened by createdAt the judge would read
    // u1 a1 u2 a1b u2b a2b — the retracted question and its answer spliced in
    // as though the founder had said them.
    const u1 = node("u1", "user", null);
    const a1 = node("a1", "assistant", "u1");
    const u2 = node("u2", "user", "a1");
    const a1b = node("a1b", "assistant", "u2");
    const u2b = node("u2b", "user", "a1");
    const a2b = node("a2b", "assistant", "u2b");

    const thread = selectActiveThread([u1, a1, u2, a1b, u2b, a2b]);

    expect(ids(thread)).toEqual(["u1", "a1", "u2b", "a2b"]);
    expect(ids(thread)).not.toContain("u2");
    expect(ids(thread)).not.toContain("a1b");
  });

  it("drops the superseded reply when an answer is regenerated", () => {
    const u1 = node("u1", "user", null);
    const a1 = node("a1", "assistant", "u1");
    const a1Regenerated = node("a1r", "assistant", "u1");

    const thread = selectActiveThread([u1, a1, a1Regenerated]);

    expect(ids(thread)).toEqual(["u1", "a1r"]);
  });

  it("is unaffected by the order the rows arrive in", () => {
    const u1 = node("u1", "user", null);
    const a1 = node("a1", "assistant", "u1");
    const u2 = node("u2", "user", "a1");
    const a2 = node("a2", "assistant", "u2");
    const shuffled = [a2, u1, a1, u2];

    expect(ids(selectActiveThread(shuffled))).toEqual(["u1", "a1", "u2", "a2"]);
  });

  it("keeps only the PRIMARY reply of a parallel group", () => {
    // Finding 3's root cause: parallel responses put N assistant messages under
    // one user turn, so a positional `slice(-2)` on the flattened list returns
    // two assistant turns and no question at all.
    const u1 = node("u1", "user", null);
    const p0 = node("a0", "assistant", "u1", {
      parallelGroupId: "g1",
      parallelIndex: 0,
      isPrimaryParallel: true,
    });
    const p1 = node("a1", "assistant", "u1", {
      parallelGroupId: "g1",
      parallelIndex: 1,
      isPrimaryParallel: false,
    });
    const p2 = node("a2", "assistant", "u1", {
      parallelGroupId: "g1",
      parallelIndex: 2,
      isPrimaryParallel: false,
    });

    const thread = selectActiveThread([u1, p0, p1, p2]);

    expect(ids(thread)).toEqual(["u1", "a0"]);
    // The last two turns are now genuinely "the question and its answer".
    expect(thread.slice(-2).map((t) => t.role)).toEqual(["user", "assistant"]);
  });

  it("takes the lowest parallelIndex when no primary is flagged", () => {
    const u1 = node("u1", "user", null);
    const p1 = node("a1", "assistant", "u1", {
      parallelGroupId: "g1",
      parallelIndex: 1,
    });
    const p0 = node("a0", "assistant", "u1", {
      parallelGroupId: "g1",
      parallelIndex: 0,
    });

    expect(ids(selectActiveThread([u1, p1, p0]))).toEqual(["u1", "a0"]);
  });

  it("continues down the branch the founder carried on from", () => {
    const u1 = node("u1", "user", null);
    const p0 = node("a0", "assistant", "u1", {
      parallelGroupId: "g1",
      parallelIndex: 0,
      isPrimaryParallel: true,
    });
    const p1 = node("a1", "assistant", "u1", {
      parallelGroupId: "g1",
      parallelIndex: 1,
    });
    const u2 = node("u2", "user", "a0");
    const a2 = node("a2", "assistant", "u2");

    expect(ids(selectActiveThread([u1, p0, p1, u2, a2]))).toEqual([
      "u1",
      "a0",
      "u2",
      "a2",
    ]);
  });

  it("is not dragged onto an abandoned branch by a slow parallel reply", () => {
    // The order of the two rules is load-bearing. u2 was retracted in favour of
    // u2b, but u2's SECOND parallel reply finished last — parallel streams do
    // finish at different times — so the newest row in the whole chat sits on
    // the branch the founder threw away. Ranking branches by "newest message
    // anywhere beneath them" follows the retracted one.
    const u1 = node("u1", "user", null);
    const a1 = node("a1", "assistant", "u1");
    const u2 = node("u2", "user", "a1");
    const a1b = node("a1b", "assistant", "u2", {
      parallelGroupId: "retracted",
      parallelIndex: 0,
      isPrimaryParallel: true,
    });
    const u2b = node("u2b", "user", "a1");
    const a2b = node("a2b", "assistant", "u2b");
    const a1cSlow = node("a1c", "assistant", "u2", {
      parallelGroupId: "retracted",
      parallelIndex: 1,
      isPrimaryParallel: false,
    });

    const thread = selectActiveThread([u1, a1, u2, a1b, u2b, a2b, a1cSlow]);

    expect(ids(thread)).toEqual(["u1", "a1", "u2b", "a2b"]);
  });

  it("follows the branch that was continued, not merely the one created last", () => {
    // The founder forked at a1, sent u2b, then went back and carried on down
    // u2. The live branch is the one with newer work on it.
    const u1 = node("u1", "user", null);
    const a1 = node("a1", "assistant", "u1");
    const u2 = node("u2", "user", "a1");
    const u2b = node("u2b", "user", "a1");
    const a2 = node("a2", "assistant", "u2");
    const u3 = node("u3", "user", "a2");

    expect(ids(selectActiveThread([u1, a1, u2, u2b, a2, u3]))).toEqual([
      "u1",
      "a1",
      "u2",
      "a2",
      "u3",
    ]);
  });

  it("keeps two chats' trees separate instead of interleaving them", () => {
    // The project-scoped transcript passes every chat at once. Two roots must
    // come out as two runs, never spliced together by timestamp.
    const c1u1 = node("c1u1", "user", null);
    const c2u1 = node("c2u1", "user", null);
    const c1a1 = node("c1a1", "assistant", "c1u1");
    const c2a1 = node("c2a1", "assistant", "c2u1");

    expect(ids(selectActiveThread([c1u1, c2u1, c1a1, c2a1]))).toEqual([
      "c1u1",
      "c1a1",
      "c2u1",
      "c2a1",
    ]);
  });

  it("keeps a message whose parent is missing rather than dropping it", () => {
    // A partial read must degrade to less context, never to silently missing
    // turns — "not assessed" and "blocked" are not the same state.
    const orphan = node("orphan", "user", "gone");
    const reply = node("reply", "assistant", "orphan");

    expect(ids(selectActiveThread([orphan, reply]))).toEqual([
      "orphan",
      "reply",
    ]);
  });

  it("terminates on a corrupt parent cycle instead of hanging", () => {
    const a: Node = {
      id: "a",
      role: "user",
      metadata: { parentMessageId: "b", createdAt: new Date(1) },
    };
    const b: Node = {
      id: "b",
      role: "assistant",
      metadata: { parentMessageId: "a", createdAt: new Date(2) },
    };

    // Every row is reachable from no root, so nothing is emitted twice and the
    // call returns.
    const thread = selectActiveThread([a, b]);
    expect(new Set(ids(thread)).size).toBe(thread.length);
  });

  it("never emits a message twice and never invents one", () => {
    const u1 = node("u1", "user", null);
    const a1 = node("a1", "assistant", "u1");
    const a1b = node("a1b", "assistant", "u1");
    const u2 = node("u2", "user", "a1b");
    const all = [u1, a1, a1b, u2];

    const thread = selectActiveThread(all);
    const allIds = new Set(ids(all));
    expect(new Set(ids(thread)).size).toBe(thread.length);
    for (const id of ids(thread)) {
      expect(allIds.has(id)).toBe(true);
    }
  });

  it("is deterministic", () => {
    const messages = [
      node("u1", "user", null),
      node("a1", "assistant", "u1"),
      node("a1b", "assistant", "u1"),
      node("u2", "user", "a1b"),
    ];
    expect(ids(selectActiveThread(messages))).toEqual(
      ids(selectActiveThread(messages))
    );
  });
});
