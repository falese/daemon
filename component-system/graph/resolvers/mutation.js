import {
  StateObject,
  Experience,
  Layout,
  Component,
  Transition
} from '../models/index.js';
import { pubsub, TOPICS } from '../pubsub.js';
import { resolveTransition, availableTransitions } from '../graph/traverse.js';

function gqlKindToMongo(kind) {
  return kind === 'STATE_OBJECT' ? 'StateObject' : 'Experience';
}

export const MutationResolvers = {
  // ── Graph construction ────────────────────────────────────────────────────

  createStateObject: async (_p, { type, data }) => {
    const doc = await StateObject.create({ type, data: data || {} });
    return doc.toObject();
  },

  createExperience: async (_p, { name }) => {
    const doc = await Experience.create({ name });
    return doc.toObject();
  },

  createLayout: async (_p, { type, experienceId }) => {
    const layout = await Layout.create({ type });
    if (experienceId) {
      await Experience.updateOne(
        { _id: experienceId },
        { $push: { layouts: { kind: 'Layout', ref: layout._id } } }
      );
    }
    return layout.toObject();
  },

  createComponent: async (_p, { type, data, parentLayoutId, parentComponentId }) => {
    const parentKind = parentLayoutId ? 'Layout' : parentComponentId ? 'Component' : null;
    const parentId = parentLayoutId || parentComponentId || null;
    const comp = await Component.create({ type, data: data || {}, parentId, parentKind });

    if (parentLayoutId) {
      await Layout.updateOne(
        { _id: parentLayoutId },
        { $push: { children: { kind: 'Component', ref: comp._id } } }
      );
    } else if (parentComponentId) {
      await Component.updateOne(
        { _id: parentComponentId },
        { $push: { children: { kind: 'Component', ref: comp._id } } }
      );
    }
    return comp.toObject();
  },

  addChildLayout: async (_p, { parentLayoutId, childLayoutId }) => {
    await Layout.updateOne(
      { _id: parentLayoutId },
      { $push: { children: { kind: 'Layout', ref: childLayoutId } } }
    );
    return Layout.findById(parentLayoutId).lean();
  },

  addChildComponent: async (_p, { parentId, parentKind, childComponentId }) => {
    const Model = parentKind === 'Layout' ? Layout : Component;
    await Model.updateOne(
      { _id: parentId },
      { $push: { children: { kind: 'Component', ref: childComponentId } } }
    );
    await Component.updateOne(
      { _id: childComponentId },
      { $set: { parentId, parentKind } }
    );
    return childComponentId;
  },

  // ── Edge wiring ───────────────────────────────────────────────────────────

  addTransition: async (_p, { sourceNodeId, sourceKind, actionType, targetExperienceId, metadata }) => {
    const sourceKindMongo = gqlKindToMongo(sourceKind);
    try {
      const doc = await Transition.create({
        sourceNodeId,
        sourceKind: sourceKindMongo,
        actionType,
        targetExperienceId,
        metadata: metadata || {}
      });
      return doc.toObject();
    } catch (err) {
      if (err.code === 11000) {
        throw new Error(
          `Transition already exists for (${sourceKind}, ${sourceNodeId}, ${actionType})`
        );
      }
      throw err;
    }
  },

  // ── Runtime — the one-experience state machine ────────────────────────────

  mutateState: async (_p, { id, action }, ctx) => {
    const stateId = id;
    const state = await StateObject.findById(stateId);
    if (!state) throw new Error(`StateObject ${stateId} not found`);

    // Merge inbound action data into the state, increment version.
    if (action.data && typeof action.data === 'object') {
      state.data = { ...(state.data || {}), ...action.data };
    }
    state.version += 1;

    // Look up the deterministic edge for this action from the current node.
    const edge = await resolveTransition(state, action.type, ctx);
    let transitioned = false;
    if (edge && !state.satisfiedEdgeIds.includes(edge._id)) {
      state.satisfiedEdgeIds.push(edge._id);
      state.currentNodeId = edge.targetExperienceId;
      state.currentNodeKind = 'Experience';
      transitioned = true;
    }

    await state.save();
    const savedState = state.toObject();

    // Compute terminal flag against the (possibly new) current node.
    const avail = await availableTransitions(savedState, ctx);
    const terminal = avail.length === 0;

    let experience = null;
    if (savedState.currentNodeKind === 'Experience') {
      experience = await ctx.loaders.experienceById.load(savedState.currentNodeId);
    }

    if (transitioned && experience) {
      pubsub.publish(TOPICS.EXPERIENCE_UPDATED(stateId), {
        experienceUpdated: {
          stateId,
          experience,
          actionType: action.type,
          terminal
        }
      });
    }
    pubsub.publish(TOPICS.STATE_UPDATED(stateId), { stateUpdated: savedState });

    return { state: savedState, experience, transitioned, terminal };
  },

  resetState: async (_p, { id }) => {
    const stateId = id;
    const state = await StateObject.findById(stateId);
    if (!state) throw new Error(`StateObject ${stateId} not found`);
    state.currentNodeId = state._id;
    state.currentNodeKind = 'StateObject';
    state.satisfiedEdgeIds = [];
    state.version += 1;
    await state.save();
    const savedState = state.toObject();
    pubsub.publish(TOPICS.STATE_UPDATED(stateId), { stateUpdated: savedState });
    return savedState;
  }
};
