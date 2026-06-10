// ============================================================
// DaemonService contract tests — resolution pipeline (ADR-054)
// ============================================================
// Run with: npm test (builds dist/ then `node --test __tests__/`).
// Plain JS on node:test so the suite needs no installed dependencies.
// ============================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  DaemonService,
  StaticMfeDirectory,
  isResolution,
  isRenderedExperience,
  isActionRecord,
  buildMessage,
  toExperienceComponent,
  experienceFromComponent,
  resolutionFromComponent,
  EXPERIENCE_COMPONENT_TYPE,
  RESOLUTION_COMPONENT_TYPE,
  RESOLUTION_ERROR_COMPONENT_TYPE,
} = require('../dist');

// ── Test doubles ─────────────────────────────────────────────

class TestDaemon extends DaemonService {
  constructor(config, deps) {
    super(config, deps);
    this.published = [];
    this.forwarded = [];
  }
  async start() {}
  async stop() {}
  connectToRegistry() {}
  async onRendererMessage(envelope) { return this.handleMessage(envelope); }
  publish(message) { this.published.push(message); }
  async forwardActionToRegistry(envelope) { this.forwarded.push(envelope); }
  // Test accessors for protected members
  receiveFromRegistry(component) { return this.handleComponentFromRegistry(component); }
  sessionFor(id) { return this.sessions.get(id); }
}

function makeInvoker(overrides = {}) {
  const calls = [];
  const invoker = {
    calls,
    async authorizeAccess(mfe, ctx) { calls.push(['authorizeAccess', mfe.name, ctx]); return true; },
    async load(mfe, ctx) { calls.push(['load', mfe.name, ctx]); },
    async render(mfe, resolution, ctx) {
      calls.push(['render', mfe.name, ctx]);
      return {
        id: 'exp-1',
        mfe: resolution.mfe,
        capability: resolution.capability,
        output: '<p>rendered</p>',
        contentType: 'text/html',
        props: resolution.props,
        createdAt: new Date().toISOString(),
      };
    },
    async refresh(mfe, resolution, ctx) { calls.push(['refresh', mfe.name, ctx]); },
    ...overrides,
  };
  return invoker;
}

const registration = {
  name: 'csv-analyzer',
  version: '1.0.0',
  type: 'tool',
  baseUrl: 'http://csv-analyzer:8000',
  capabilities: ['authorizeAccess', 'load', 'render', 'refresh'],
};

function makeDaemon(invoker) {
  return new TestDaemon({ mfes: [registration] }, { mfeInvoker: invoker });
}

const resolutionComponent = (extra = {}) => ({
  id: 'res-1',
  type: RESOLUTION_COMPONENT_TYPE,
  data: { mfe: 'csv-analyzer', capability: 'DataAnalysis', props: { fileId: 'f1' }, ...extra },
  createdAt: new Date().toISOString(),
});

// ── Resolution pipeline ──────────────────────────────────────

test('resolution → authorize, load, render, relay EXPERIENCE component', async () => {
  const invoker = makeInvoker();
  const daemon = makeDaemon(invoker);

  await daemon.receiveFromRegistry(resolutionComponent({ correlationId: 'corr-7' }));

  assert.deepEqual(invoker.calls.map(c => c[0]), ['authorizeAccess', 'load', 'render']);
  assert.equal(daemon.published.length, 1);
  const message = daemon.published[0];
  assert.equal(message.kind, 'COMPONENT_UPDATE');
  assert.equal(message.metadata.correlationId, 'corr-7');
  assert.equal(message.metadata.acknowledged, true);
  assert.equal(message.payload.type, EXPERIENCE_COMPONENT_TYPE);
  const experience = experienceFromComponent(message.payload);
  assert.ok(isRenderedExperience(experience));
  assert.equal(experience.mfe, 'csv-analyzer');
  assert.equal(experience.output, '<p>rendered</p>');
  // The experience is cached so later actions get STATE_SNAPSHOTs
  assert.equal(daemon.getComponents().length, 1);
});

test('same resolution again → refresh, not a second render', async () => {
  const invoker = makeInvoker();
  const daemon = makeDaemon(invoker);

  await daemon.receiveFromRegistry(resolutionComponent());
  await daemon.receiveFromRegistry(resolutionComponent());

  const kinds = invoker.calls.map(c => c[0]);
  assert.equal(kinds.filter(k => k === 'render').length, 1);
  assert.equal(kinds.filter(k => k === 'load').length, 1);
  assert.equal(kinds.filter(k => k === 'refresh').length, 1);
});

test('authorization denied → RESOLUTION_ERROR published, render never called', async () => {
  const invoker = makeInvoker({ async authorizeAccess() { return false; } });
  const daemon = makeDaemon(invoker);

  await daemon.receiveFromRegistry(resolutionComponent({ correlationId: 'corr-x' }));

  assert.equal(invoker.calls.some(c => c[0] === 'render'), false);
  const message = daemon.published[0];
  assert.equal(message.payload.type, RESOLUTION_ERROR_COMPONENT_TYPE);
  assert.equal(message.metadata.error, 'access denied');
  assert.equal(message.metadata.correlationId, 'corr-x');
});

test('unknown MFE → RESOLUTION_ERROR published', async () => {
  const daemon = makeDaemon(makeInvoker());

  await daemon.receiveFromRegistry({
    id: 'res-2',
    type: RESOLUTION_COMPONENT_TYPE,
    data: { mfe: 'nope', capability: 'X', props: {} },
    createdAt: new Date().toISOString(),
  });

  const message = daemon.published[0];
  assert.equal(message.payload.type, RESOLUTION_ERROR_COMPONENT_TYPE);
  assert.match(message.metadata.error, /unknown MFE/);
});

test('render throwing → RESOLUTION_ERROR with the failure reason', async () => {
  const invoker = makeInvoker({ async render() { throw new Error('MFE down'); } });
  const daemon = makeDaemon(invoker);

  await daemon.receiveFromRegistry(resolutionComponent());

  const message = daemon.published[0];
  assert.equal(message.payload.type, RESOLUTION_ERROR_COMPONENT_TYPE);
  assert.equal(message.metadata.error, 'MFE down');
});

test('session context from an action is threaded into MFE invocation', async () => {
  const invoker = makeInvoker();
  const daemon = makeDaemon(invoker);
  const session = { sessionId: 's-1', user: { id: 'u-1', roles: ['analyst'] }, jwt: 'jwt-1', application: 'web' };

  await daemon.handleMessage(buildMessage({
    direction: 'ACTION',
    kind: 'ACTION',
    payload: {
      id: 'a-1', componentId: 'exp-0', actionType: 'CLICK', data: {},
      timestamp: new Date().toISOString(), context: session,
    },
    correlationId: 'corr-1',
  }));
  assert.deepEqual(daemon.sessionFor('s-1'), session);

  await daemon.receiveFromRegistry(resolutionComponent({ sessionId: 's-1' }));
  const renderCall = invoker.calls.find(c => c[0] === 'render');
  assert.equal(renderCall[2].session.user.id, 'u-1');
  assert.equal(renderCall[2].session.jwt, 'jwt-1');
});

test('per-session active resolutions: a second session renders, not refreshes', async () => {
  const invoker = makeInvoker();
  const daemon = makeDaemon(invoker);

  await daemon.receiveFromRegistry(resolutionComponent({ sessionId: 's-1' }));
  await daemon.receiveFromRegistry(resolutionComponent({ sessionId: 's-2' }));

  const kinds = invoker.calls.map(c => c[0]);
  assert.equal(kinds.filter(k => k === 'render').length, 2);
  assert.equal(kinds.filter(k => k === 'refresh').length, 0);
  // load still runs once — it is per MFE, not per session
  assert.equal(kinds.filter(k => k === 'load').length, 1);
});

test('client-side MFE (module-federation): experience synthesized, no HTTP capability calls', async () => {
  const invoker = makeInvoker();
  const daemon = new TestDaemon({
    mfes: [{
      name: 'abc-kids-flappy',
      version: '1.0.0',
      type: 'remote',
      baseUrl: 'http://localhost:3001',
      capabilities: ['load', 'render'],
      contentType: 'module-federation',
      remoteEntryUrl: 'http://localhost:3001/remoteEntry.js',
      moduleFederation: { scope: 'abc_kids_flappy', module: './App', component: 'PlayGame' },
    }],
  }, { mfeInvoker: invoker });

  await daemon.receiveFromRegistry({
    id: 'res-mf',
    type: RESOLUTION_COMPONENT_TYPE,
    data: { mfe: 'abc-kids-flappy', capability: 'PlayGame', props: { slot: 'main', level: 2 }, correlationId: 'corr-mf' },
    createdAt: new Date().toISOString(),
  });

  // The lifecycle runs in the host shell — no HTTP invocation at all
  assert.deepEqual(invoker.calls, []);
  const message = daemon.published[0];
  assert.equal(message.kind, 'COMPONENT_UPDATE');
  assert.equal(message.metadata.correlationId, 'corr-mf');
  assert.equal(message.payload.type, EXPERIENCE_COMPONENT_TYPE);
  const experience = experienceFromComponent(message.payload);
  assert.equal(experience.contentType, 'module-federation');
  assert.deepEqual(experience.output, {
    remoteEntryUrl: 'http://localhost:3001/remoteEntry.js',
    scope: 'abc_kids_flappy',
    module: './App',
    component: 'PlayGame',
    props: { slot: 'main', level: 2 },
  });
  assert.deepEqual(experience.props, { slot: 'main', level: 2 });
});

// ── Legacy migration behaviour ───────────────────────────────

test('legacy component passthrough: store then broadcast unchanged', async () => {
  const daemon = makeDaemon(makeInvoker());
  const card = { id: 'c-1', type: 'CARD', data: { title: 'hi' }, createdAt: new Date().toISOString() };

  await daemon.receiveFromRegistry(card);

  assert.equal(daemon.published.length, 1);
  assert.equal(daemon.published[0].kind, 'COMPONENT_UPDATE');
  assert.deepEqual(daemon.published[0].payload, card);
  assert.equal(daemon.getComponents().length, 1);
});

test('5-step action pipeline unchanged: echo then snapshot then forward', async () => {
  const daemon = makeDaemon(makeInvoker());
  const card = { id: 'c-1', type: 'CARD', data: {}, createdAt: new Date().toISOString() };
  await daemon.receiveFromRegistry(card);
  daemon.published.length = 0;

  const echo = await daemon.handleMessage(buildMessage({
    direction: 'ACTION',
    kind: 'ACTION',
    payload: {
      id: 'a-1', componentId: 'c-1', actionType: 'BUTTON_CLICK', data: {},
      timestamp: new Date().toISOString(),
    },
    correlationId: 'corr-2',
  }));

  assert.equal(echo.kind, 'ACTION_ECHO');
  assert.equal(echo.payload.actionType, 'CLICK'); // normalised
  assert.deepEqual(daemon.published.map(m => m.kind), ['ACTION_ECHO', 'STATE_SNAPSHOT']);
  assert.equal(daemon.forwarded.length, 1);
});

// ── Canonical helpers & re-exports ───────────────────────────

test('experience component round-trip', () => {
  const experience = {
    id: 'e-9', mfe: 'm', capability: 'C', output: { a: 1 },
    contentType: 'application/json', createdAt: new Date().toISOString(),
  };
  const component = toExperienceComponent(experience);
  assert.equal(component.type, EXPERIENCE_COMPONENT_TYPE);
  assert.deepEqual(experienceFromComponent(component), experience);
  assert.equal(resolutionFromComponent(component), null);
});

test('canonical guards are re-exported from @seans-mfe/contracts', () => {
  assert.equal(isResolution({ mfe: 'm', capability: 'c', props: {} }), true);
  assert.equal(isResolution({ id: 'c1', type: 'CARD', data: {} }), false);
  assert.equal(isActionRecord({ componentId: 'c', actionType: 'CLICK', data: {} }), true);
});

test('StaticMfeDirectory registers and looks up', async () => {
  const directory = new StaticMfeDirectory([registration]);
  assert.equal((await directory.lookup('csv-analyzer')).baseUrl, registration.baseUrl);
  assert.equal(await directory.lookup('missing'), null);
  directory.register({ ...registration, name: 'other' });
  assert.ok(await directory.lookup('other'));
});
