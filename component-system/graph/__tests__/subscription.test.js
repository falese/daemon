import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearCollections,
  exec
} from './setup.js';
import { pubsub, TOPICS } from '../pubsub.js';

describe('subscriptions', () => {
  let mongo;
  beforeAll(async () => {
    mongo = await startInMemoryMongo();
  });
  afterAll(async () => {
    await stopInMemoryMongo(mongo);
  });
  beforeEach(async () => {
    await clearCollections();
  });

  test('experienceUpdated fires when a transition succeeds', async () => {
    const state = (
      await exec(`mutation { createStateObject(type:"x", data:{}) { id } }`)
    ).createStateObject;
    const exp = (
      await exec(`mutation { createExperience(name:"E") { id } }`)
    ).createExperience;
    await exec(
      `mutation($s:ID!,$t:ID!){ addTransition(sourceNodeId:$s, sourceKind:STATE_OBJECT, actionType:"GO", targetExperienceId:$t){ id } }`,
      { s: state.id, t: exp.id }
    );

    // Collect publishes by listening on the pubsub channel directly.
    const events = [];
    const iter = pubsub.asyncIterableIterator(TOPICS.EXPERIENCE_UPDATED(state.id));
    const collect = (async () => {
      const { value } = await iter.next();
      events.push(value);
    })();

    await exec(
      `mutation($id:ID!){ mutateState(id:$id, action:{type:"GO"}) { transitioned } }`,
      { id: state.id }
    );

    await collect;
    expect(events).toHaveLength(1);
    expect(events[0].experienceUpdated.stateId).toBe(state.id);
    expect(events[0].experienceUpdated.actionType).toBe('GO');
    expect(events[0].experienceUpdated.terminal).toBe(true);
    expect(events[0].experienceUpdated.experience.id).toBe(exp.id);
    iter.return && (await iter.return());
  });

  test('experienceUpdated does NOT fire when no transition matches', async () => {
    const state = (
      await exec(`mutation { createStateObject(type:"x", data:{}) { id } }`)
    ).createStateObject;

    let fired = false;
    const iter = pubsub.asyncIterableIterator(TOPICS.EXPERIENCE_UPDATED(state.id));
    const watcher = (async () => {
      const { value } = await iter.next();
      if (value) fired = true;
    })();

    await exec(
      `mutation($id:ID!){ mutateState(id:$id, action:{type:"NOPE"}) { transitioned } }`,
      { id: state.id }
    );

    // Give the event loop a tick to let any publish propagate.
    await new Promise((r) => setTimeout(r, 50));
    iter.return && (await iter.return());
    await watcher.catch(() => {});

    expect(fired).toBe(false);
  });
});
