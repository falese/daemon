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
    if (parentLayoutId === childLayoutId) {
      throw new Error('Layout cannot contain itself');
    }
    const [parentExists, childExists] = await Promise.all([
      Layout.exists({ _id: parentLayoutId }),
      Layout.exists({ _id: childLayoutId })
    ]);
    if (!parentExists) throw new Error(`Layout ${parentLayoutId} not found`);
    if (!childExists) throw new Error(`Layout ${childLayoutId} not found`);
    // Full ancestor-walk cycle detection is deferred: enforceDepth() in the
    // query path already prevents infinite recursion. A cycle would surface
    // as a MAX_DEPTH_EXCEEDED error on the affected subtree.
    await Layout.updateOne(
      { _id: parentLayoutId },
      { $push: { children: { kind: 'Layout', ref: childLayoutId } } }
    );
    return Layout.findById(parentLayoutId).lean();
  },

  addChildComponent: async (_p, { parentId, parentKind, childComponentId }) => {
    if (parentKind === 'Component' && parentId === childComponentId) {
      throw new Error('Component cannot contain itself');
    }
    const ParentModel = parentKind === 'Layout' ? Layout : Component;
    const [parentExists, childExists] = await Promise.all([
      ParentModel.exists({ _id: parentId }),
      Component.exists({ _id: childComponentId })
    ]);
    if (!parentExists) throw new Error(`${parentKind} ${parentId} not found`);
    if (!childExists) throw new Error(`Component ${childComponentId} not found`);
    await ParentModel.updateOne(
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

    // Snapshot the state to decide what (if anything) needs to change.
    const snapshot = await StateObject.findById(stateId).lean();
    if (!snapshot) throw new Error(`StateObject ${stateId} not found`);

    const edge = await resolveTransition(snapshot, action.type, ctx);
    const willTransition =
      !!edge && !(snapshot.satisfiedEdgeIds || []).includes(edge._id);

    const hasActionData =
      action.data && typeof action.data === 'object' &&
      Object.keys(action.data).length > 0;

    // True no-op: no matching/unsatisfied edge AND no action payload.
    // Skip the write and the publish so `version` and STATE_UPDATED stay
    // meaningful as "this state actually changed" signals.
    if (!willTransition && !hasActionData) {
      const avail = await availableTransitions(snapshot, ctx);
      return {
        state: snapshot,
        experience: null,
        transitioned: false,
        terminal: avail.length === 0
      };
    }

    // Build a single atomic update. The CAS predicate `version: snapshot.version`
    // prevents two concurrent actions from both observing the edge as unsatisfied
    // and racing through it — the second writer gets null back and we throw.
    const $set = {};
    const update = { $inc: { version: 1 }, $set };
    if (hasActionData) {
      for (const [k, v] of Object.entries(action.data)) {
        $set[`data.${k}`] = v;
      }
    }
    if (willTransition) {
      $set.currentNodeId = edge.targetExperienceId;
      $set.currentNodeKind = 'Experience';
      update.$addToSet = { satisfiedEdgeIds: edge._id };
    }

    const updated = await StateObject.findOneAndUpdate(
      { _id: stateId, version: snapshot.version },
      update,
      { new: true, lean: true }
    );
    if (!updated) {
      throw new Error(
        `StateObject ${stateId} was concurrently modified (expected version ${snapshot.version}); retry`
      );
    }

    const avail = await availableTransitions(updated, ctx);
    const terminal = avail.length === 0;

    let experience = null;
    if (updated.currentNodeKind === 'Experience') {
      experience = await ctx.loaders.experienceById.load(updated.currentNodeId);
    }

    if (willTransition && experience) {
      pubsub.publish(TOPICS.EXPERIENCE_UPDATED(stateId), {
        experienceUpdated: {
          stateId,
          experience,
          actionType: action.type,
          terminal
        }
      });
    }
    pubsub.publish(TOPICS.STATE_UPDATED(stateId), { stateUpdated: updated });

    return { state: updated, experience, transitioned: willTransition, terminal };
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
