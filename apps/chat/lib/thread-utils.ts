// Generic message type that works for both DB and anonymous messages
export interface MessageNode {
  id: string;
  metadata?: {
    parentMessageId: string | null;
    parallelGroupId?: string | null;
    parallelIndex?: number | null;
    isPrimaryParallel?: boolean | null;
    activeStreamId?: string | null;
    createdAt: Date;
  };
}

/** Safely extract a numeric timestamp from a Date object or ISO string. */
function toTimestamp(value: Date | string | undefined | null): number {
  if (!value) {
    return 0;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  return new Date(value).getTime();
}

// Get the default leaf (most recent message by timestamp)
function getDefaultLeafMessage<T extends MessageNode>(
  allMessages: T[]
): T | null {
  if (allMessages.length === 0) {
    return null;
  }

  // Sort by createdAt descending and return the first one
  const sorted = [...allMessages].sort(
    (a, b) =>
      toTimestamp(b.metadata?.createdAt) - toTimestamp(a.metadata?.createdAt)
  );

  return sorted[0];
}

// Build thread from leaf message using all messages
export function buildThreadFromLeaf<T extends MessageNode>(
  allMessages: T[],
  leafMessageId: string
): T[] {
  const messageMap = new Map<string, T>();
  for (const msg of allMessages) {
    messageMap.set(msg.id, msg);
  }

  const thread: T[] = [];
  let currentMessageId: string | null = leafMessageId;
  let iteration = 0;

  while (currentMessageId) {
    iteration += 1;

    if (iteration > 100) {
      break;
    }

    const currentMessage = messageMap.get(currentMessageId);
    if (!currentMessage) {
      break;
    }

    thread.unshift(currentMessage);

    // Check for self-reference
    if (currentMessage.metadata?.parentMessageId === currentMessage.id) {
      console.error(
        "[buildThreadFromLeaf] SELF-REFERENCE DETECTED for message:",
        currentMessage.id
      );
      break;
    }

    currentMessageId = currentMessage.metadata?.parentMessageId || null;
  }

  return thread;
}

// Get default thread (combination of the above two)
export function getDefaultThread<T extends MessageNode>(allMessages: T[]): T[] {
  const defaultLeaf = getDefaultLeafMessage(allMessages);
  if (!defaultLeaf) {
    return [];
  }

  return buildThreadFromLeaf(allMessages, defaultLeaf.id);
}

// Build parent->children mapping sorted by createdAt
export function buildChildrenMap<T extends MessageNode>(
  allMessages: T[]
): Map<string | null, T[]> {
  const map = new Map<string | null, T[]>();
  for (const message of allMessages) {
    const parentId = message.metadata?.parentMessageId || null;
    if (!map.has(parentId)) {
      map.set(parentId, []);
    }
    map.get(parentId)?.push(message);
  }
  for (const siblings of map.values()) {
    siblings.sort((a, b) => {
      const aParallelIndex = a.metadata?.parallelIndex;
      const bParallelIndex = b.metadata?.parallelIndex;
      const sameParallelGroup =
        a.metadata?.parallelGroupId &&
        a.metadata?.parallelGroupId === b.metadata?.parallelGroupId;

      if (
        sameParallelGroup &&
        typeof aParallelIndex === "number" &&
        typeof bParallelIndex === "number" &&
        aParallelIndex !== bParallelIndex
      ) {
        return aParallelIndex - bParallelIndex;
      }

      return (
        toTimestamp(a.metadata?.createdAt) - toTimestamp(b.metadata?.createdAt)
      );
    });
  }
  return map;
}

/**
 * PURE. The messages that actually HAPPENED, oldest first — one live path per
 * conversation tree, with every abandoned branch and every non-primary parallel
 * response removed.
 *
 * WHY THIS EXISTS. Message rows form a TREE: editing a message or regenerating
 * a reply forks a sibling branch, and both branches keep their rows forever
 * (that is what makes the branch switcher work). Reading those rows back in
 * `createdAt` order flattens the tree into a straight line, which splices
 * abandoned drafts into the middle of the conversation as though the founder
 * had said them. For a chat UI that is invisible — it renders one path. For the
 * phase gate it is not: the judge reads the flattened list as real evidence and
 * can BLOCK on a turn that was retracted, or credit a criterion from an answer
 * the founder deliberately replaced.
 *
 * THE RULE, at every branch point, IN THIS ORDER:
 *   1. COLLAPSE PARALLEL GROUPS FIRST. Parallel responses are N replies to a
 *      single user turn; only `isPrimaryParallel` is the answer of record (it
 *      is the one the post-turn phase pass is allowed to learn from — see
 *      route.ts), and emitting all N would hand the judge one question with
 *      three answers. With no primary flagged, buildChildrenMap has already
 *      ordered the group by parallelIndex, so the lowest index stands in.
 *   2. THEN follow the branch that leads to the newest message. An edit or a
 *      regenerate is newer than what it replaced, so this is exactly "the
 *      branch the founder kept". Ties break on the child's own timestamp and
 *      then on id, so identical timestamps still give one deterministic answer.
 *
 * THE ORDER OF THOSE TWO IS LOAD-BEARING. Parallel streams finish at different
 * times, so an abandoned branch's second reply can be the newest row in the
 * whole chat. Ranking branches by "newest message anywhere beneath them" would
 * then follow the retracted branch — a slow discarded response would decide
 * what the judge reads. Collapsing the groups before ranking means only
 * messages that are themselves on a live path can win the comparison.
 *
 * Messages from several chats can be passed together (the project-scoped
 * transcript does exactly that): each root starts its own tree, and the trees
 * are emitted in root order, so two conversations are never interleaved.
 */
export function selectActiveThread<T extends MessageNode>(
  allMessages: T[]
): T[] {
  if (allMessages.length === 0) {
    return [];
  }

  const byId = new Map<string, T>();
  for (const message of allMessages) {
    byId.set(message.id, message);
  }
  const children = buildChildrenMap(allMessages);

  /** Rule 1 — one representative per parallel group, groupless nodes as-is. */
  const collapseParallelGroups = (candidates: T[]): T[] => {
    const seenGroups = new Set<string>();
    const representatives: T[] = [];
    for (const candidate of candidates) {
      const groupId = candidate.metadata?.parallelGroupId;
      if (!groupId) {
        representatives.push(candidate);
        continue;
      }
      if (seenGroups.has(groupId)) {
        continue;
      }
      seenGroups.add(groupId);
      const group = candidates.filter(
        (c) => c.metadata?.parallelGroupId === groupId
      );
      representatives.push(
        group.find((c) => c.metadata?.isPrimaryParallel === true) ?? group[0]
      );
    }
    return representatives;
  };

  /**
   * The newest timestamp reachable from `node` FOLLOWING THIS SAME RULE — not
   * the newest anywhere in its subtree. Memoised, and seeded before recursing
   * so a corrupt parent/child cycle terminates instead of overflowing.
   */
  const liveNewest = new Map<string, number>();
  // Explicitly typed: computeLiveNewest and pickChild are mutually recursive,
  // and inference cannot break that cycle on its own.
  const computeLiveNewest: (node: T) => number = (node) => {
    const cached = liveNewest.get(node.id);
    if (cached !== undefined) {
      return cached;
    }
    const own = toTimestamp(node.metadata?.createdAt);
    liveNewest.set(node.id, own);
    const next: T[] = children.get(node.id) ?? [];
    const chosen: T | undefined =
      next.length === 0 ? undefined : pickChild(next);
    const newest = chosen ? Math.max(own, computeLiveNewest(chosen)) : own;
    liveNewest.set(node.id, newest);
    return newest;
  };

  function pickChild(candidates: T[]): T {
    const representatives = collapseParallelGroups(candidates);
    let best = representatives[0];
    let bestNewest = computeLiveNewest(best);
    for (const candidate of representatives.slice(1)) {
      const newest = computeLiveNewest(candidate);
      const tie =
        newest === bestNewest &&
        (toTimestamp(candidate.metadata?.createdAt) >
          toTimestamp(best.metadata?.createdAt) ||
          (toTimestamp(candidate.metadata?.createdAt) ===
            toTimestamp(best.metadata?.createdAt) &&
            candidate.id > best.id));
      if (newest > bestNewest || tie) {
        best = candidate;
        bestNewest = newest;
      }
    }
    return best;
  }

  // A message whose parent is absent from this set is a root of its own tree —
  // never dropped, so a partial read degrades to "less context", not "silently
  // missing turns".
  const roots = allMessages.filter((message) => {
    const parentId = message.metadata?.parentMessageId;
    return !(parentId && byId.has(parentId));
  });
  roots.sort(
    (a, b) =>
      toTimestamp(a.metadata?.createdAt) - toTimestamp(b.metadata?.createdAt) ||
      (a.id < b.id ? -1 : 1)
  );

  const thread: T[] = [];
  const visited = new Set<string>();
  for (const root of roots) {
    let current: T | undefined = root;
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      thread.push(current);
      const next: T[] = children.get(current.id) ?? [];
      current = next.length === 0 ? undefined : pickChild(next);
    }
  }

  return thread;
}

export function findLeafDfsToRightFromMessageId<T extends MessageNode>(
  childrenMapSorted: Map<string | null, T[]>,
  messageId: string
): T | null {
  const children = childrenMapSorted.get(messageId);
  if (!children || children.length === 0) {
    return null;
  }

  const rightmostChild = children.at(-1);

  if (!rightmostChild) {
    return null;
  }

  const leaf = findLeafDfsToRightFromMessageId(
    childrenMapSorted,
    rightmostChild.id
  );
  return leaf || rightmostChild;
}
