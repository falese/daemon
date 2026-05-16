import { enforceDepth } from '../graph/traverse.js';

export const ComponentResolvers = {
  id: (c) => c._id,
  createdAt: (c) => c.createdAt,

  parent: async (c, _a, ctx) => {
    if (!c.parentId || c.parentKind !== 'Component') return null;
    return ctx.loaders.componentById.load(c.parentId);
  },

  children: async (parent, _args, ctx, info) => {
    enforceDepth(info);
    const ids = (parent.children || []).map((ch) => ch.ref);
    if (ids.length === 0) return [];
    const rows = await ctx.loaders.componentById.loadMany(ids);
    return rows.filter(Boolean);
  }
};
