import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearCollections,
  exec,
  execRaw
} from './setup.js';

describe('edge enforcement', () => {
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

  test('duplicate (source, actionType) is rejected', async () => {
    const state = (
      await exec(`mutation { createStateObject(type:"x", data:{}) { id } }`)
    ).createStateObject;
    const exp1 = (await exec(`mutation { createExperience(name:"E1") { id } }`)).createExperience;
    const exp2 = (await exec(`mutation { createExperience(name:"E2") { id } }`)).createExperience;

    await exec(
      `mutation($s:ID!,$t:ID!){ addTransition(sourceNodeId:$s, sourceKind:STATE_OBJECT, actionType:"GO", targetExperienceId:$t){ id } }`,
      { s: state.id, t: exp1.id }
    );

    const result = await execRaw(
      `mutation($s:ID!,$t:ID!){ addTransition(sourceNodeId:$s, sourceKind:STATE_OBJECT, actionType:"GO", targetExperienceId:$t){ id } }`,
      { s: state.id, t: exp2.id }
    );
    expect(result.errors).toBeDefined();
    expect(result.errors[0].message).toMatch(/already exists/i);
  });

  test('same actionType is allowed when sourceKind differs', async () => {
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
    // exp itself as source uses sourceKind=EXPERIENCE — distinct (source, sourceKind, action) tuple.
    const r = await execRaw(
      `mutation($s:ID!,$t:ID!){ addTransition(sourceNodeId:$s, sourceKind:EXPERIENCE, actionType:"GO", targetExperienceId:$t){ id } }`,
      { s: exp.id, t: exp.id }
    );
    expect(r.errors).toBeUndefined();
  });
});
