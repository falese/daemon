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

  test('action with no matching edge does not transition', async () => {
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
    // No match → no transition, but state data/version still update.
    expect(r.mutateState.transitioned).toBe(false);
    expect(r.mutateState.experience).toBeNull();
    expect(r.mutateState.state.version).toBe(1);
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
});
