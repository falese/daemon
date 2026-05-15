// Pure helpers for walking the experience graph.
//
// All functions take the apollo `ctx` and use the per-request DataLoaders so
// repeated lookups inside one query collapse into batched Mongo finds.

export function nodeKey(kind, id) {
  return `${kind}:${id}`;
}

// Resolve the (deterministic) outgoing edge for an actionType from the state's current node.
// Returns null when no edge matches.
export async function resolveTransition(state, actionType, ctx) {
  const edges = await ctx.loaders.transitionsFromNode.load(
    nodeKey(state.currentNodeKind, state.currentNodeId)
  );
  return edges.find((e) => e.actionType === actionType) || null;
}

// All outgoing edges from the cursor, minus edges already in satisfiedEdgeIds.
export async function availableTransitions(state, ctx) {
  const edges = await ctx.loaders.transitionsFromNode.load(
    nodeKey(state.currentNodeKind, state.currentNodeId)
  );
  const satisfied = new Set(state.satisfiedEdgeIds || []);
  return edges.filter((e) => !satisfied.has(e._id));
}

// Recursion guard for query-time recursive resolvers (Layout.children, Component.children).
// Walks the `info.path` linked list and throws if depth exceeds the cap.
const MAX_DEPTH = parseInt(process.env.GRAPH_MAX_DEPTH || '24', 10);

export function enforceDepth(info, max = MAX_DEPTH) {
  let depth = 0;
  let p = info.path;
  while (p) {
    depth += 1;
    p = p.prev;
  }
  if (depth > max) {
    const err = new Error(`MAX_DEPTH_EXCEEDED: query depth ${depth} exceeds cap ${max}`);
    err.extensions = { code: 'MAX_DEPTH_EXCEEDED' };
    throw err;
  }
}
