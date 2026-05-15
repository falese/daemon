import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearCollections,
  exec
} from './setup.js';

describe('recursive Layout / Component queries', () => {
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

  test('deep tree: Experience > Layout > Layout > Component > Component resolves correctly', async () => {
    const exp = (await exec(`mutation { createExperience(name:"E") { id } }`)).createExperience;
    const outerLayout = (
      await exec(
        `mutation($e:ID!){ createLayout(type:"PAGE", experienceId:$e) { id } }`,
        { e: exp.id }
      )
    ).createLayout;
    const innerLayout = (await exec(`mutation { createLayout(type:"ROW") { id } }`)).createLayout;
    await exec(
      `mutation($p:ID!,$c:ID!){ addChildLayout(parentLayoutId:$p, childLayoutId:$c){ id } }`,
      { p: outerLayout.id, c: innerLayout.id }
    );

    const card = (
      await exec(
        `mutation($p:ID!){ createComponent(type:"CARD", data:{title:"top"}, parentLayoutId:$p) { id } }`,
        { p: innerLayout.id }
      )
    ).createComponent;
    const child = (
      await exec(
        `mutation($p:ID!){ createComponent(type:"BADGE", data:{label:"new"}, parentComponentId:$p) { id } }`,
        { p: card.id }
      )
    ).createComponent;

    const q = `
      query($id:ID!) {
        experience(id:$id) {
          layouts {
            id
            children {
              __typename
              ... on Layout {
                id
                children {
                  __typename
                  ... on Component { id type data children { id type } }
                }
              }
            }
          }
        }
      }
    `;
    const got = await exec(q, { id: exp.id });
    expect(got.experience.layouts).toHaveLength(1);
    expect(got.experience.layouts[0].id).toBe(outerLayout.id);
    expect(got.experience.layouts[0].children[0].__typename).toBe('Layout');
    expect(got.experience.layouts[0].children[0].id).toBe(innerLayout.id);
    expect(got.experience.layouts[0].children[0].children[0].__typename).toBe('Component');
    expect(got.experience.layouts[0].children[0].children[0].id).toBe(card.id);
    expect(got.experience.layouts[0].children[0].children[0].children[0].id).toBe(child.id);
  });
});
