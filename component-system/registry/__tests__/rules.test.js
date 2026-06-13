// ========================
// RULES ENGINE UNIT TESTS
// ========================
// Tests the core rule evaluation logic of the Registry in isolation —
// no server, no WebSocket, no GraphQL. Just the ComponentRegistry class.
//
// Run with:  npm test  (from component-system/registry/)
//
// These tests verify:
//   1. Each default rule fires when its condition is met
//   2. Rules do NOT fire when condition is not met
//   3. A rule condition that throws is caught (doesn't crash the server)
//   4. A rule generate() that throws is caught (doesn't crash the server)
//   5. Rules are independent — both fire when both conditions are met

import { ComponentRegistry } from '../simple-registry.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeComponent(id, type, data = {}) {
  return { id, type, data, createdAt: new Date().toISOString() };
}

function makeAction(id, componentId, actionType, data = {}) {
  return { id, componentId, actionType, data, timestamp: new Date().toISOString() };
}

function makeState(component) {
  return { component, actions: [], lastUpdated: new Date().toISOString() };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Rules Engine', () => {
  let registry;
  // Collect all components published via pubsub so we can assert on them
  let publishedComponents;

  beforeEach(() => {
    registry = new ComponentRegistry();
    publishedComponents = [];

    // Intercept renderComponent so tests don't need a live pubsub
    const originalRender = registry.renderComponent.bind(registry);
    registry.renderComponent = (spec) => {
      const component = originalRender(spec);
      publishedComponents.push(component);
      return component;
    };
  });

  // ── card-click rule ─────────────────────────────────────────────────────────

  describe('card-click rule', () => {
    test('fires when a CARD component receives a CLICK action', async () => {
      const component = makeComponent('comp-1', 'CARD', { title: 'Test Card' });
      const state     = makeState(component);
      const action    = makeAction('act-1', 'comp-1', 'CLICK');

      registry.components.set('comp-1', state);

      await registry.handleAction({ direction: 'ACTION', payload: action });

      expect(publishedComponents).toHaveLength(1);
      expect(publishedComponents[0].type).toBe('NOTIFICATION');
    });

    test('does NOT fire for CARD + SUBMIT (wrong action type)', async () => {
      const component = makeComponent('comp-1', 'CARD', { title: 'Test Card' });
      registry.components.set('comp-1', makeState(component));

      await registry.handleAction({ direction: 'ACTION', payload: makeAction('act-1', 'comp-1', 'SUBMIT') });

      expect(publishedComponents).toHaveLength(0);
    });

    test('does NOT fire for NOTIFICATION + CLICK (wrong component type)', async () => {
      const component = makeComponent('comp-1', 'NOTIFICATION', { message: 'Hello' });
      registry.components.set('comp-1', makeState(component));

      await registry.handleAction({ direction: 'ACTION', payload: makeAction('act-1', 'comp-1', 'CLICK') });

      expect(publishedComponents).toHaveLength(0);
    });

    test('generated NOTIFICATION contains the rule evaluation metadata', async () => {
      const component = makeComponent('comp-1', 'CARD', { title: 'Clickable' });
      registry.components.set('comp-1', makeState(component));

      await registry.handleAction({ direction: 'ACTION', payload: makeAction('act-1', 'comp-1', 'CLICK') });

      const notification = publishedComponents[0];
      expect(notification.data._ruleEvaluation).toBeDefined();
      expect(notification.data._ruleEvaluation.rule).toBe('card-click');
    });
  });

  // ── form-submit rule ────────────────────────────────────────────────────────

  describe('form-submit rule', () => {
    test('fires when a FORM component receives a SUBMIT action', async () => {
      const component = makeComponent('comp-2', 'FORM', { title: 'Contact', fields: [] });
      registry.components.set('comp-2', makeState(component));

      await registry.handleAction({
        direction: 'ACTION',
        payload: makeAction('act-2', 'comp-2', 'SUBMIT', { name: 'Alice', email: 'alice@example.com' })
      });

      expect(publishedComponents).toHaveLength(1);
      expect(publishedComponents[0].type).toBe('CARD');
    });

    test('generated CARD includes the submitted form data', async () => {
      const component = makeComponent('comp-2', 'FORM', { title: 'Contact' });
      registry.components.set('comp-2', makeState(component));

      const formData = { name: 'Bob', message: 'Hello' };
      await registry.handleAction({
        direction: 'ACTION',
        payload: makeAction('act-2', 'comp-2', 'SUBMIT', formData)
      });

      const card = publishedComponents[0];
      expect(card.data.content).toContain('Bob');
    });

    test('does NOT fire for FORM + CLICK (wrong action type)', async () => {
      const component = makeComponent('comp-2', 'FORM', { title: 'Contact' });
      registry.components.set('comp-2', makeState(component));

      await registry.handleAction({ direction: 'ACTION', payload: makeAction('act-2', 'comp-2', 'CLICK') });

      expect(publishedComponents).toHaveLength(0);
    });
  });

  // ── Error handling ──────────────────────────────────────────────────────────

  describe('error handling', () => {
    test('a rule condition that throws is caught — other rules still run', async () => {
      // Add a rule whose condition throws
      registry.rules.set('bad-condition', {
        condition: () => { throw new Error('condition boom'); },
        generate:  () => ({ type: 'CARD', data: { title: 'Should not appear' } })
      });

      const component = makeComponent('comp-3', 'CARD', {});
      registry.components.set('comp-3', makeState(component));

      // Should not throw; card-click should still fire
      await expect(
        registry.handleAction({ direction: 'ACTION', payload: makeAction('act-3', 'comp-3', 'CLICK') })
      ).resolves.not.toThrow();

      // card-click fired (1 NOTIFICATION), bad-condition was skipped
      expect(publishedComponents).toHaveLength(1);
      expect(publishedComponents[0].type).toBe('NOTIFICATION');
    });

    test('a rule generate() that throws is caught — other rules still run', async () => {
      // Add a rule whose generate throws after a truthy condition
      registry.rules.set('bad-generate', {
        condition: (state) => state.component.type === 'CARD',
        generate:  () => { throw new Error('generate boom'); }
      });

      const component = makeComponent('comp-4', 'CARD', {});
      registry.components.set('comp-4', makeState(component));

      await expect(
        registry.handleAction({ direction: 'ACTION', payload: makeAction('act-4', 'comp-4', 'CLICK') })
      ).resolves.not.toThrow();

      // card-click fired, bad-generate was skipped
      expect(publishedComponents).toHaveLength(1);
    });

    test('returns null when no component state exists for the action target', async () => {
      const result = await registry.handleAction({
        direction: 'ACTION',
        payload: makeAction('act-5', 'nonexistent-id', 'CLICK')
      });

      expect(result).toBeNull();
      expect(publishedComponents).toHaveLength(0);
    });
  });

  // ── Multiple rules ──────────────────────────────────────────────────────────

  describe('multiple rules', () => {
    test('all matching rules fire independently', async () => {
      // Add a second rule that also matches CARD + CLICK
      registry.rules.set('card-click-secondary', {
        condition: (state, action) =>
          state.component.type === 'CARD' && action.actionType === 'CLICK',
        generate: () => ({ type: 'NOTIFICATION', data: { message: 'Secondary rule fired', status: 'INFO' } })
      });

      const component = makeComponent('comp-5', 'CARD', {});
      registry.components.set('comp-5', makeState(component));

      await registry.handleAction({ direction: 'ACTION', payload: makeAction('act-5', 'comp-5', 'CLICK') });

      // Both card-click and card-click-secondary should have fired
      expect(publishedComponents).toHaveLength(2);
      expect(publishedComponents.every(c => c.type === 'NOTIFICATION')).toBe(true);
    });
  });

  // ── MFE registration + resolution routes (PLATFORM-CONTRACT v3.2 / ADR-054) ─

  describe('MFE resolution routes', () => {
    const registration = {
      name: 'csv-analyzer',
      version: '1.0.0',
      type: 'tool',
      baseUrl: 'http://csv-analyzer:8000',
      capabilities: ['render', 'refresh', 'authorizeAccess']
    };

    test('registerMfe stores the registration and exposes it via getMfes', () => {
      registry.registerMfe(registration, []);
      expect(registry.getMfes()).toEqual([registration]);
    });

    test('registerMfe rejects a registration without name/baseUrl', () => {
      expect(() => registry.registerMfe({ name: 'x' })).toThrow(/baseUrl/);
    });

    test('a matching route generates a RESOLUTION with correlation and session threading', async () => {
      registry.registerMfe(registration, [
        { when: { componentType: 'FORM', actionType: 'SUBMIT' },
          resolve: { capability: 'DataAnalysis', props: { mode: 'full' } } }
      ]);

      const component = makeComponent('form-1', 'FORM', {});
      registry.components.set('form-1', makeState(component));

      const action = makeAction('act-9', 'form-1', 'SUBMIT', { fileId: 'f-1' });
      action.context = { sessionId: 's-1', user: { id: 'u-1' }, application: 'web' };

      await registry.handleAction({
        direction: 'ACTION',
        payload: action,
        metadata: { correlationId: 'corr-9', acknowledged: false, error: null }
      });

      const resolution = publishedComponents.find(c => c.type === 'RESOLUTION');
      expect(resolution).toBeDefined();
      expect(resolution.data.mfe).toBe('csv-analyzer');
      expect(resolution.data.capability).toBe('DataAnalysis');
      // route props merged with the action data that triggered the resolution
      expect(resolution.data.props).toMatchObject({ mode: 'full', fileId: 'f-1' });
      // routing context for the daemon's per-session render/refresh decision
      expect(resolution.data.correlationId).toBe('corr-9');
      expect(resolution.data.sessionId).toBe('s-1');
    });

    test('a stateKey route fires even when the registry has no component state', async () => {
      registry.registerMfe(registration, [
        { when: { stateKey: 'analysis.complete' },
          resolve: { capability: 'Visualization' } }
      ]);

      const action = makeAction('act-10', 'unknown-experience', 'STATE_UPDATE', { resultId: 'r-1' });
      action.stateKey = 'analysis.complete';

      await registry.handleAction({ direction: 'ACTION', payload: action });

      const resolution = publishedComponents.find(c => c.type === 'RESOLUTION');
      expect(resolution).toBeDefined();
      expect(resolution.data.capability).toBe('Visualization');
      expect(resolution.data.props).toMatchObject({ resultId: 'r-1' });
    });

    test('a route with an empty `when` never fires', async () => {
      registry.registerMfe(registration, [
        { when: {}, resolve: { capability: 'Everything' } }
      ]);

      const component = makeComponent('card-9', 'CARD', {});
      registry.components.set('card-9', makeState(component));

      await registry.handleAction({ direction: 'ACTION', payload: makeAction('act-11', 'card-9', 'CLICK') });

      expect(publishedComponents.some(c => c.type === 'RESOLUTION')).toBe(false);
    });
  });
});
