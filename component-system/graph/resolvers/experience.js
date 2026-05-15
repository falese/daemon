import { Transition } from '../models/index.js';

export const ExperienceResolvers = {
  id: (e) => e._id,
  createdAt: (e) => e.createdAt,

  layouts: async (e, _a, ctx) => {
    const ids = (e.layouts || []).map((l) => l.ref);
    if (ids.length === 0) return [];
    const rows = await ctx.loaders.layoutById.loadMany(ids);
    return rows.filter(Boolean);
  },

  outgoingTransitions: async (e) => {
    // Direct read — outgoingTransitions is rarely co-fetched with other Experiences
    // in the same query, so a DataLoader buys little. Keep it simple.
    return Transition.find({ sourceKind: 'Experience', sourceNodeId: e._id }).lean();
  }
};
