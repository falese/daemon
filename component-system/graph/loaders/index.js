import DataLoader from 'dataloader';
import { StateObject, Experience, Layout, Component, Transition } from '../models/index.js';

// Generic "find these ids, return them in the same order, fill misses with null"
function batchByIdFactory(Model) {
  return async (ids) => {
    const docs = await Model.find({ _id: { $in: ids } }).lean();
    const map = new Map(docs.map((d) => [d._id, d]));
    return ids.map((id) => map.get(id) || null);
  };
}

// keys here are strings of form "Kind:id" so we can batch StateObject-rooted and
// Experience-rooted lookups in one call to Mongo (one find per kind).
async function batchTransitionsByNode(keys) {
  const buckets = { StateObject: [], Experience: [] };
  for (const k of keys) {
    const [kind, id] = k.split(':');
    if (buckets[kind]) buckets[kind].push(id);
  }
  const lookups = [];
  if (buckets.StateObject.length) {
    lookups.push(
      Transition.find({ sourceKind: 'StateObject', sourceNodeId: { $in: buckets.StateObject } }).lean()
    );
  }
  if (buckets.Experience.length) {
    lookups.push(
      Transition.find({ sourceKind: 'Experience', sourceNodeId: { $in: buckets.Experience } }).lean()
    );
  }
  const allRows = (await Promise.all(lookups)).flat();

  const grouped = new Map();
  for (const row of allRows) {
    const key = `${row.sourceKind}:${row.sourceNodeId}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return keys.map((k) => grouped.get(k) || []);
}

export function buildLoaders() {
  return {
    stateById: new DataLoader(batchByIdFactory(StateObject)),
    experienceById: new DataLoader(batchByIdFactory(Experience)),
    layoutById: new DataLoader(batchByIdFactory(Layout)),
    componentById: new DataLoader(batchByIdFactory(Component)),
    transitionById: new DataLoader(batchByIdFactory(Transition)),
    transitionsFromNode: new DataLoader(batchTransitionsByNode)
  };
}
