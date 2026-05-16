#!/usr/bin/env node
// End-to-end smoke test for the graph service.
// Usage:  node test-graph.js [http://localhost:4100]
//
// Requires Node 18+ (built-in fetch). No npm install needed.

const BASE = process.argv[2] || 'http://localhost:4100';
const GQL  = `${BASE}/graphql`;

async function gql(query, variables = {}) {
  const res = await fetch(GQL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  const json = await res.json();
  if (json.errors?.length) {
    const msg = json.errors.map(e => e.message).join('\n');
    throw new Error(`GraphQL error:\n${msg}`);
  }
  return json.data;
}

async function main() {
  console.log(`\n🔗 Testing graph service at ${GQL}\n`);

  // ── Health check ─────────────────────────────────────────────────────────
  const health = await fetch(BASE).then(r => r.json());
  console.log('✅ Health:', JSON.stringify(health));
  if (health.mongo !== 'connected') {
    throw new Error('Mongo not connected — is the mongo service running?');
  }

  // ── Build the experience graph ────────────────────────────────────────────
  const { createStateObject: state } = await gql(
    `mutation { createStateObject(type: "checkout", data: {}) { id version isTerminal } }`
  );
  console.log('\n📦 StateObject:', state);

  const [cart, addr, confirm] = await Promise.all([
    gql(`mutation { createExperience(name: "Cart")    { id name } }`).then(d => d.createExperience),
    gql(`mutation { createExperience(name: "Address") { id name } }`).then(d => d.createExperience),
    gql(`mutation { createExperience(name: "Confirm") { id name } }`).then(d => d.createExperience)
  ]);
  console.log('🗂  Experiences:', [cart.name, addr.name, confirm.name].join(' → '));

  // Add a layout + component to Cart so the recursive query is exercised
  const layout = await gql(
    `mutation($e: ID!) { createLayout(type: "PAGE", experienceId: $e) { id } }`,
    { e: cart.id }
  ).then(d => d.createLayout);
  await gql(
    `mutation($p: ID!) { createComponent(type: "CARD", data: {title: "Your cart"}, parentLayoutId: $p) { id } }`,
    { p: layout.id }
  );

  // ── Wire transitions ──────────────────────────────────────────────────────
  await gql(
    `mutation($s:ID!,$t:ID!) { addTransition(sourceNodeId:$s, sourceKind:STATE_OBJECT, actionType:"START", targetExperienceId:$t) { id } }`,
    { s: state.id, t: cart.id }
  );
  await gql(
    `mutation($s:ID!,$t:ID!) { addTransition(sourceNodeId:$s, sourceKind:EXPERIENCE, actionType:"NEXT", targetExperienceId:$t) { id } }`,
    { s: cart.id, t: addr.id }
  );
  await gql(
    `mutation($s:ID!,$t:ID!) { addTransition(sourceNodeId:$s, sourceKind:EXPERIENCE, actionType:"NEXT", targetExperienceId:$t) { id } }`,
    { s: addr.id, t: confirm.id }
  );
  console.log('🔀 Transitions wired: STATE→Cart, Cart→Address, Address→Confirm');

  // ── Walk the state machine ────────────────────────────────────────────────
  async function step(action) {
    return gql(
      `mutation($id:ID!, $a:ActionInput!) {
         mutateState(id:$id, action:$a) {
           transitioned terminal
           experience {
             name
             layouts { children { __typename ... on Component { type data } } }
           }
           state { version isTerminal availableTransitions { actionType } }
         }
       }`,
      { id: state.id, a: action }
    ).then(d => d.mutateState);
  }

  let r;

  r = await step({ type: 'START' });
  console.log('\n▶ START →', r.experience?.name, `| transitioned: ${r.transitioned} | terminal: ${r.terminal}`);
  console.log('  Layouts/components:', JSON.stringify(r.experience?.layouts));
  console.assert(r.transitioned,              'START should transition');
  console.assert(r.experience?.name === 'Cart', 'Should land on Cart');
  console.assert(!r.terminal,                 'Cart should not be terminal');

  r = await step({ type: 'NEXT' });
  console.log('\n▶ NEXT  →', r.experience?.name, `| transitioned: ${r.transitioned} | terminal: ${r.terminal}`);
  console.assert(r.experience?.name === 'Address', 'Should land on Address');

  r = await step({ type: 'NEXT' });
  console.log('\n▶ NEXT  →', r.experience?.name, `| transitioned: ${r.transitioned} | terminal: ${r.terminal}`);
  console.assert(r.experience?.name === 'Confirm', 'Should land on Confirm');
  console.assert(r.terminal,                       'Confirm should be terminal');

  // ── No-op: no matching edge, no data ─────────────────────────────────────
  r = await step({ type: 'NOPE' });
  console.log('\n⏭  NOPE (no-op) → transitioned:', r.transitioned, '| version:', r.state.version);
  console.assert(!r.transitioned, 'NOPE should not transition');

  // ── Enforcement: duplicate transition rejected ────────────────────────────
  try {
    await gql(
      `mutation($s:ID!,$t:ID!) { addTransition(sourceNodeId:$s, sourceKind:STATE_OBJECT, actionType:"START", targetExperienceId:$t) { id } }`,
      { s: state.id, t: cart.id }
    );
    throw new Error('Expected duplicate transition to be rejected');
  } catch (e) {
    if (/already exists/i.test(e.message)) {
      console.log('\n🔒 Enforcement: duplicate (source, START) correctly rejected');
    } else {
      throw e;
    }
  }

  // ── Reset ─────────────────────────────────────────────────────────────────
  const reset = await gql(
    `mutation($id:ID!) { resetState(id:$id) { version currentExperience { name } isTerminal } }`,
    { id: state.id }
  ).then(d => d.resetState);
  console.log('\n🔄 Reset state → version:', reset.version, '| currentExperience:', reset.currentExperience, '| isTerminal:', reset.isTerminal);

  console.log('\n✅ All checks passed\n');
}

main().catch(err => {
  console.error('\n❌', err.message);
  process.exit(1);
});
