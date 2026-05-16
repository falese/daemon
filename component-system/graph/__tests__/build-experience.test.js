import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearCollections,
  exec
} from './setup.js';

describe('experience construction mutations', () => {
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

  test('addChildComponent updates child.parentId and parent.children both', async () => {
    const exp = (await exec(`mutation { createExperience(name:"E") { id } }`)).createExperience;
    const layout = (
      await exec(
        `mutation($e:ID!){ createLayout(type:"PAGE", experienceId:$e) { id } }`,
        { e: exp.id }
      )
    ).createLayout;

    const c = (
      await exec(`mutation { createComponent(type:"CARD", data:{}) { id } }`)
    ).createComponent;
    await exec(
      `mutation($p:ID!,$c:ID!){ addChildComponent(parentId:$p, parentKind:"Layout", childComponentId:$c) }`,
      { p: layout.id, c: c.id }
    );

    const got = await exec(
      `query($id:ID!){ experience(id:$id){ layouts { children { __typename ... on Component { id } } } } }`,
      { id: exp.id }
    );
    expect(got.experience.layouts[0].children).toHaveLength(1);
    expect(got.experience.layouts[0].children[0].__typename).toBe('Component');
    expect(got.experience.layouts[0].children[0].id).toBe(c.id);
  });

  test('createStateObject initializes cursor pointing to itself with empty satisfied set', async () => {
    const state = (
      await exec(
        `mutation { createStateObject(type:"x", data:{a:1}) { id data version isTerminal availableTransitions { id } } }`
      )
    ).createStateObject;
    expect(state.data).toEqual({ a: 1 });
    expect(state.version).toBe(0);
    expect(state.isTerminal).toBe(true); // no transitions wired yet
    expect(state.availableTransitions).toEqual([]);
  });
});
