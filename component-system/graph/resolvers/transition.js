export const TransitionResolvers = {
  id: (t) => t._id,
  sourceKind: (t) => (t.sourceKind === 'StateObject' ? 'STATE_OBJECT' : 'EXPERIENCE'),
  targetExperience: (t, _a, ctx) => ctx.loaders.experienceById.load(t.targetExperienceId)
};
