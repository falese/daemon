import { StateObject } from '../models/index.js';

export const QueryResolvers = {
  stateObject: (_p, { id }, ctx) => ctx.loaders.stateById.load(id),
  stateObjects: () => StateObject.find({}).lean(),
  experience: (_p, { id }, ctx) => ctx.loaders.experienceById.load(id),
  currentExperience: async (_p, { stateId }, ctx) => {
    const state = await ctx.loaders.stateById.load(stateId);
    if (!state || state.currentNodeKind !== 'Experience') return null;
    return ctx.loaders.experienceById.load(state.currentNodeId);
  }
};
