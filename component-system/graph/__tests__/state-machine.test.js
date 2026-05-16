import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearCollections,
  exec
} from './setup.js';

describe('one-experience state machine', () => {
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

  async function makeCheckoutMachine() {
    // 3 experiences: Cart → Address → Confirm
    const cart = (
      await exec(`mutation { createExperience(name:"Cart") { id name } }`)
    ).createExperience;
    const addr = (
      await exec(`mutation { createExperience(name:"Address") { id name } }`)
    ).createExperience;
    const confirm = (
      await exec(`mutation { createExperience(name:"Confirm") { id name } }`)
    ).createExperience;

    const state = (
      await exec(
        `mutation($d:JSON){ createStateObject(type:"checkout", data:$d) { id currentExperience { id } } }`,
        { d: { cart: [] } }
      )
    ).createStateObject;

    // StateObject --START--> Cart
    await exec(
      `mutation($s:ID!,$t:ID!){ addTransition(sourceNodeId:$s, sourceKind:STATE_OBJECT, actionType:"START", targetExperienceId:$t){ id } }`,
      { s: state.id, t: cart.id }
    );
    // Cart --NEXT--> Address
    await exec(
      `mutation($s:ID!,$t:ID!){ addTransition(sourceNodeId:$s, sourceKind:EXPERIENCE, actionType:"NEXT", targetExperienceId:$t){ id } }`,
      { s: cart.id, t: addr.id }
    );
    // Address --NEXT--> Confirm
    await exec(
      `mutation($s:ID!,$t:ID!){ addTransition(sourceNodeId:$s, sourceKind:EXPERIENCE, actionType:"NEXT", targetExperienceId:$t){ id } }`,
      { s: addr.id, t: confirm.id }
    );
    return { state, cart, addr, confirm };
  }

  test('starts with no current experience, transitions through each action', async () => {
    const { state, cart, addr, confirm } = await makeCheckoutMachine();

    // Initially, currentExperience is null because the cursor is still on the state.
    const before = await exec(
      `query($id:ID!){ stateObject(id:$id) { currentExperience { id } isTerminal availableTransitions { actionType } } }`,
      { id: state.id }
    );
    expect(before.stateObject.currentExperience).toBeNull();
    expect(before.stateObject.isTerminal).toBe(false);
    expect(before.stateObject.availableTransitions.map((t) => t.actionType)).toEqual(['START']);

    // 1) START → Cart
    let r = await exec(
      `mutation($id:ID!){ mutateState(id:$id, action:{type:"START"}) { transitioned terminal experience { id name } } }`,
      { id: state.id }
    );
    expect(r.mutateState.transitioned).toBe(true);
    expect(r.mutateState.experience.id).toBe(cart.id);
    expect(r.mutateState.terminal).toBe(false);

    // 2) NEXT → Address
    r = await exec(
      `mutation($id:ID!){ mutateState(id:$id, action:{type:"NEXT"}) { transitioned experience { id } } }`,
      { id: state.id }
    );
    expect(r.mutateState.experience.id).toBe(addr.id);

    // 3) NEXT → Confirm (and now terminal — Confirm has no outgoing edges)
    r = await exec(
      `mutation($id:ID!){ mutateState(id:$id, action:{type:"NEXT"}) { transitioned terminal experience { id } } }`,
      { id: state.id }
    );
    expect(r.mutateState.experience.id).toBe(confirm.id);
    expect(r.mutateState.terminal).toBe(true);
  });

  test('action data is merged into state.data on every mutation', async () => {
    const { state } = await makeCheckoutMachine();
    await exec(
      `mutation($id:ID!,$d:JSON){ mutateState(id:$id, action:{type:"START", data:$d}) { state { data version } } }`,
      { id: state.id, d: { coupon: 'X10' } }
    );
    const got = await exec(
      `query($id:ID!){ stateObject(id:$id){ data version } }`,
      { id: state.id }
    );
    expect(got.stateObject.data.coupon).toBe('X10');
    expect(got.stateObject.data.cart).toEqual([]);
    expect(got.stateObject.version).toBe(1);
  });
});
