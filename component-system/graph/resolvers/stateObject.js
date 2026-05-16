import { availableTransitions } from '../graph/traverse.js';

export const StateObjectResolvers = {
  id: (s) => s._id,
  createdAt: (s) => s.createdAt,
  updatedAt: (s) => s.updatedAt,

  currentExperience: async (s, _a, ctx) => {
    if (s.currentNodeKind !== 'Experience' || !s.currentNodeId) return null;
    return ctx.loaders.experienceById.load(s.currentNodeId);
  },

  availableTransitions: async (s, _a, ctx) => availableTransitions(s, ctx),

  satisfiedEdges: async (s, _a, ctx) => {
    const ids = s.satisfiedEdgeIds || [];
    if (ids.length === 0) return [];
    const rows = await ctx.loaders.transitionById.loadMany(ids);
    return rows.filter(Boolean);
  },

  isTerminal: async (s, _a, ctx) => {
    const avail = await availableTransitions(s, ctx);
    return avail.length === 0;
  }
};
