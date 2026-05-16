import { enforceDepth } from '../graph/traverse.js';

export const LayoutResolvers = {
  id: (l) => l._id,
  createdAt: (l) => l.createdAt,

  children: async (parent, _args, ctx, info) => {
    enforceDepth(info);
    const out = await Promise.all(
      (parent.children || []).map(async (c) => {
        if (c.kind === 'Layout') {
          const doc = await ctx.loaders.layoutById.load(c.ref);
          return doc ? { ...doc, __kind: 'Layout' } : null;
        }
        const doc = await ctx.loaders.componentById.load(c.ref);
        return doc ? { ...doc, __kind: 'Component' } : null;
      })
    );
    return out.filter(Boolean);
  }
};

export const LayoutChildResolvers = {
  __resolveType: (obj) => obj.__kind
};
