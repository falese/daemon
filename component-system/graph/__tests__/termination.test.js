import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearCollections,
  exec
} from './setup.js';

describe('state machine termination', () => {
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

  test('action with no matching edge and no payload is a true no-op', async () => {
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

    const r = await exec(
      `mutation($id:ID!){ mutateState(id:$id, action:{type:"NOPE"}) { transitioned experience { id } state { version } } }`,
      { id: state.id }
    );
    // No matching edge AND no action.data → state is unchanged, version stays at 0.
    expect(r.mutateState.transitioned).toBe(false);
    expect(r.mutateState.experience).toBeNull();
    expect(r.mutateState.state.version).toBe(0);
  });

  test('action with payload but no matching edge merges data and bumps version', async () => {
    const state = (
      await exec(`mutation { createStateObject(type:"x", data:{}) { id } }`)
    ).createStateObject;

    const r = await exec(
      `mutation($id:ID!,$d:JSON){ mutateState(id:$id, action:{type:"NOPE", data:$d}) { transitioned state { version data } } }`,
      { id: state.id, d: { foo: 'bar' } }
    );
    expect(r.mutateState.transitioned).toBe(false);
    expect(r.mutateState.state.version).toBe(1);
    expect(r.mutateState.state.data.foo).toBe('bar');
  });

  test('isTerminal=true when all outgoing edges from current node are satisfied', async () => {
    // Single edge state machine: state --GO--> exp. After firing GO, terminal=true.
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

    const r = await exec(
      `mutation($id:ID!){ mutateState(id:$id, action:{type:"GO"}) { transitioned terminal } }`,
      { id: state.id }
    );
    expect(r.mutateState.transitioned).toBe(true);
    // Cursor is now on `exp` which has no outgoing edges → terminal.
    expect(r.mutateState.terminal).toBe(true);
  });

  test('repeat firing the same action does not re-transition (once-only)', async () => {
    const state = (
      await exec(`mutation { createStateObject(type:"x", data:{}) { id } }`)
    ).createStateObject;
    const exp1 = (await exec(`mutation { createExperience(name:"E1") { id } }`)).createExperience;
    const exp2 = (await exec(`mutation { createExperience(name:"E2") { id } }`)).createExperience;

    await exec(
      `mutation($s:ID!,$t:ID!){ addTransition(sourceNodeId:$s, sourceKind:STATE_OBJECT, actionType:"GO", targetExperienceId:$t){ id } }`,
      { s: state.id, t: exp1.id }
    );
    // Cycle back: exp1 --GO--> exp2. Note this is a different edge (Experience source), still fires once.
    await exec(
      `mutation($s:ID!,$t:ID!){ addTransition(sourceNodeId:$s, sourceKind:EXPERIENCE, actionType:"GO", targetExperienceId:$t){ id } }`,
      { s: exp1.id, t: exp2.id }
    );

    // First GO fires the StateObject→exp1 edge
    let r = await exec(
      `mutation($id:ID!){ mutateState(id:$id, action:{type:"GO"}) { transitioned experience { id } } }`,
      { id: state.id }
    );
    expect(r.mutateState.experience.id).toBe(exp1.id);

    // Second GO fires the exp1→exp2 edge
    r = await exec(
      `mutation($id:ID!){ mutateState(id:$id, action:{type:"GO"}) { transitioned experience { id } } }`,
      { id: state.id }
    );
    expect(r.mutateState.experience.id).toBe(exp2.id);

    // Third GO has no matching edge from exp2 → no transition.
    r = await exec(
      `mutation($id:ID!){ mutateState(id:$id, action:{type:"GO"}) { transitioned terminal } }`,
      { id: state.id }
    );
    expect(r.mutateState.transitioned).toBe(false);
    expect(r.mutateState.terminal).toBe(true);
  });

  test('concurrent mutateState on the same state: only one wins, other throws', async () => {
    // Build a 2-step machine: state --GO--> exp1, exp1 --GO--> exp2
    // Fire two GO actions concurrently against the freshly created state.
    // Both load the same snapshot (version=0, currentNode=state). The CAS
    // predicate on version means exactly one save succeeds; the other throws.
    const state = (
      await exec(`mutation { createStateObject(type:"x", data:{}) { id } }`)
    ).createStateObject;
    const exp1 = (await exec(`mutation { createExperience(name:"E1") { id } }`)).createExperience;
    await exec(
      `mutation($s:ID!,$t:ID!){ addTransition(sourceNodeId:$s, sourceKind:STATE_OBJECT, actionType:"GO", targetExperienceId:$t){ id } }`,
      { s: state.id, t: exp1.id }
    );

    const fire = () =>
      exec(
        `mutation($id:ID!){ mutateState(id:$id, action:{type:"GO"}) { transitioned } }`,
        { id: state.id }
      ).then(
        (data) => ({ ok: true, transitioned: data.mutateState.transitioned }),
        (err) => ({ ok: false, err: err.message })
      );

    const results = await Promise.all([fire(), fire()]);
    const successes = results.filter((r) => r.ok && r.transitioned);
    const conflicts = results.filter((r) => !r.ok && /concurrently modified/i.test(r.err));
    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(1);

    // The persisted state should reflect exactly one transition.
    const after = await exec(
      `query($id:ID!){ stateObject(id:$id){ version satisfiedEdges { id } currentExperience { id } } }`,
      { id: state.id }
    );
    expect(after.stateObject.version).toBe(1);
    expect(after.stateObject.satisfiedEdges).toHaveLength(1);
    expect(after.stateObject.currentExperience.id).toBe(exp1.id);
  });
});
