// ========================
// COMPONENT REGISTRY
// ========================
// Role in the system:
//   - Stores the state of every active component (component + its action history)
//   - Evaluates rules when an action arrives and generates new components
//   - Publishes component updates via GraphQL subscription so the daemon can
//     pick them up and forward them to connected renderers
//
// Ports / endpoints:
//   POST /render          – inject a component directly (used by Makefile `make form`)
//   POST /graphql         – GraphQL over HTTP (queries + mutations)
//   WS   /graphql         – GraphQL over WebSocket (subscriptions, graphql-transport-ws)

import { ApolloServer } from 'apollo-server-express';
import { createServer } from 'http';
import { useServer } from 'graphql-ws/use/ws';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { PubSub } from 'graphql-subscriptions';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { WebSocketServer } from 'ws';

// How long a component stays in memory before being evicted.
// Keeps the in-memory store from growing forever in a long-running demo.
const COMPONENT_TTL_MS = parseInt(process.env.COMPONENT_TTL_MS || '600000', 10); // default 10 min

// ========================
// REGISTRY
// ========================

class ComponentRegistry {
  constructor() {
    this.components = new Map(); // id -> { component, actions: [], lastUpdated }
    this.rules = new Map();      // ruleName -> { condition(state, action), generate(state, action) }
    this.pubsub = new PubSub();

    this.setupDefaultRules();
  }

  // ── Rules ─────────────────────────────────────────────────────────────────
  // Each rule has:
  //   condition(state, action) → boolean   — should this rule fire?
  //   generate(state, action)  → { type, data }  — what component to create?

  setupDefaultRules() {
    // Rule: clicking a CARD produces a NOTIFICATION placed into the card's 'detail' slot
    this.rules.set('card-click', {
      condition: (state, action) =>
        state.component.type === 'CARD' &&
        action.actionType === 'CLICK',
      generate: (state, _action) => ({
        type: 'NOTIFICATION',
        data: {
          message: `Card "${state.component.data?.title || state.component.id}" was clicked!`,
          status: 'INFO',
          // Routing intent: the daemon will place this notification into the
          // card's 'detail' slot. The NOTIFICATION itself does not know this.
          _slot: { parentId: state.component.id, slotName: 'detail' }
        }
      })
    });

    // Rule: submitting a FORM produces a CARD summarising the submitted data.
    // The CARD declares a 'detail' slot so further interactions can compose into it.
    this.rules.set('form-submit', {
      condition: (state, action) =>
        state.component.type === 'FORM' &&
        action.actionType === 'SUBMIT',
      generate: (_state, action) => ({
        type: 'CARD',
        slots: ['detail'],
        data: {
          title: 'Form Submission',
          content: JSON.stringify(action.data),
          timestamp: new Date().toISOString()
        }
      })
    });
  }

  // ── Message dispatch ───────────────────────────────────────────────────────

  handleMessage(message) {
    // Validate the envelope before dispatching
    if (!message || typeof message !== 'object' || !message.direction) {
      console.warn('⚠️  Registry: Received malformed message (missing direction), ignoring');
      return null;
    }

    console.log(`📨 Registry: Handling message direction=${message.direction}`);

    if (message.direction === 'ACTION') {
      return this.handleAction(message);
    } else if (message.direction === 'COMPONENT') {
      return this.updateComponentState(message);
    } else {
      console.warn(`⚠️  Registry: Unknown message direction "${message.direction}", ignoring`);
      return null;
    }
  }

  // ── Action handling + rule evaluation ─────────────────────────────────────

  async handleAction(message) {
    const action = message.payload;
    console.log(`🎯 Registry: Processing action componentId=${action.componentId} actionType=${action.actionType}`);

    const state = this.components.get(action.componentId);
    if (!state) {
      console.warn(`⚠️  Registry: No state for component ${action.componentId} — rules cannot be evaluated`);
      return null;
    }

    console.log(`🧪 Registry: Evaluating ${this.rules.size} rule(s) for type=${state.component.type} action=${action.actionType}`);
    let triggered = false;

    for (const [ruleName, rule] of this.rules) {
      // Step 1: test the condition (errors are caught so one bad rule doesn't block the rest)
      let conditionMet = false;
      try {
        conditionMet = rule.condition(state, action);
      } catch (e) {
        console.error(`❌ Registry: Rule "${ruleName}" condition threw:`, e.message);
        continue;
      }

      console.log(`🔍 Registry: Rule "${ruleName}" → ${conditionMet ? 'MATCH' : 'no match'}`);
      if (!conditionMet) continue;

      // Step 2: generate the new component (errors are caught separately)
      let componentSpec;
      try {
        componentSpec = rule.generate(state, action);
      } catch (e) {
        console.error(`❌ Registry: Rule "${ruleName}" generate() threw:`, e.message);
        continue;
      }

      // Attach rule evaluation metadata so the renderer can show which rule fired
      componentSpec.data = Object.assign({}, componentSpec.data || {}, {
        _ruleEvaluation: {
          rule: ruleName,
          facts: {
            componentId: state.component.id,
            componentType: state.component.type,
            actionId: action.id,
            actionType: action.actionType
          },
          timestamp: new Date().toISOString()
        }
      });

      console.log(`✨ Registry: Rule "${ruleName}" triggered — publishing ${componentSpec.type} component`);
      await this.renderComponent(componentSpec);
      triggered = true;
    }

    if (!triggered) {
      console.log(`🚫 Registry: No rules matched (actionType=${action.actionType} componentType=${state.component.type})`);
    }

    return true;
  }

  // ── Component state ────────────────────────────────────────────────────────

  // Called by the daemon when it sends a COMPONENT-direction message (state sync)
  updateComponentState(message) {
    const state = message.payload;
    console.log(`📝 Registry: Updating state for component ${state.component.id}`);
    this.components.set(state.component.id, state);
    return true;
  }

  // Create a new component, store it, schedule its eviction, and publish it
  renderComponent({ type, data, slots }) {
    const component = {
      id: uuidv4(),
      type,
      data,
      createdAt: new Date().toISOString(),
      ...(slots?.length ? { slots } : {})
    };

    const state = {
      component,
      actions: [],
      lastUpdated: new Date().toISOString()
    };

    this.components.set(component.id, state);

    // Evict after TTL so the in-memory store doesn't grow forever
    setTimeout(() => this.components.delete(component.id), COMPONENT_TTL_MS);

    console.log(`📦 Registry: Publishing component id=${component.id} type=${component.type}`);

    // Publish on the COMPONENT_UPDATE channel — the daemon's persistent
    // subscription will pick this up and forward it to all connected renderers
    this.pubsub.publish('COMPONENT_UPDATE', { componentUpdate: component });

    return component;
  }

  getComponents() {
    return Array.from(this.components.values()).map(s => s.component);
  }

  getComponentStates() {
    return Array.from(this.components.values());
  }
}

// ========================
// GRAPHQL SCHEMA
// ========================

const typeDefs = `
  scalar JSON

  type Query {
    components: [Component!]!
    componentStates: [ComponentState!]!
  }

  type Mutation {
    # Inject a component directly (type = CARD | NOTIFICATION | FORM)
    renderComponent(type: ComponentType!, data: JSON!, slots: [String!]): Component!

    # Route a message envelope from the daemon (direction = ACTION | COMPONENT)
    handleMessage(message: String!): Boolean!
  }

  type Subscription {
    # Fires whenever renderComponent() or a rule generates a new component.
    # The daemon subscribes here and forwards updates to all renderers.
    componentUpdate: Component!
  }

  type Component {
    id: String!
    type: ComponentType!
    data: JSON!
    createdAt: String!
    slots: [String!]
  }

  type Action {
    id: String!
    componentId: String!
    actionType: String!
    data: JSON!
    timestamp: String!
  }

  type ComponentState {
    component: Component!
    actions: [Action!]!
    lastUpdated: String!
  }

  enum ComponentType {
    CARD
    NOTIFICATION
    FORM
  }
`;

// ========================
// RESOLVERS
// ========================

function createResolvers(registry) {
  return {
    Query: {
      components: () => registry.getComponents(),
      componentStates: () => registry.getComponentStates()
    },

    Mutation: {
      renderComponent: (_, { type, data, slots }) => {
        console.log(`🎨 Registry: renderComponent type=${type}`);
        return registry.renderComponent({ type, data, slots });
      },
      handleMessage: async (_, { message }) => {
        let parsed;
        try {
          parsed = JSON.parse(message);
        } catch {
          throw new Error('handleMessage: message must be a valid JSON string');
        }
        return registry.handleMessage(parsed);
      }
    },

    Subscription: {
      componentUpdate: {
        subscribe: () => registry.pubsub.asyncIterableIterator('COMPONENT_UPDATE')
      }
    }
  };
}

// ========================
// SERVER
// ========================

async function startRegistry(port = 4000) {
  const resolvedPort = parseInt(process.env.PORT || String(port), 10) || port;
  const app = express();
  const httpServer = createServer(app);
  const registry = new ComponentRegistry();

  app.use(express.json());

  // REST: inject a component directly — used by `make form`
  app.post('/render', (req, res) => {
    const { type, data } = req.body;
    const component = registry.renderComponent({ type, data });
    res.json({ success: true, component });
  });

  // Health check
  app.get('/', (_req, res) => {
    res.json({
      service: 'control-plane-registry',
      components: registry.getComponents().length,
      endpoints: { GraphQL: '/graphql', REST: '/render' }
    });
  });

  const schema = makeExecutableSchema({ typeDefs, resolvers: createResolvers(registry) });

  const server = new ApolloServer({ schema, context: () => ({ registry }) });
  await server.start();
  server.applyMiddleware({ app, path: '/graphql' });

  // WebSocket server (graphql-transport-ws protocol)
  const wsServer = new WebSocketServer({ server: httpServer, path: '/graphql' });

  // Debug: log the raw WS protocol header on each new connection so you can
  // confirm the daemon is using 'graphql-transport-ws'. The graphql-ws library
  // takes over handling from here — this listener is read-only observation.
  wsServer.on('connection', (_socket, req) => {
    console.log('🔌 Registry: WS connection, protocol:', req.headers['sec-websocket-protocol']);
  });

  useServer({
    schema,
    context: () => ({ registry }),
    onConnect: (ctx) => {
      console.log('🔌 Registry: graphql-ws client connected from', ctx.extra.request.socket.remoteAddress);
    },
    onDisconnect: () => {
      console.log('🔌 Registry: graphql-ws client disconnected');
    },
    onError: (_ctx, _msg, errors) => {
      console.error('❌ Registry: graphql-ws error:', errors);
    }
  }, wsServer);

  httpServer.listen(resolvedPort, '0.0.0.0', () => {
    console.log(`🚀 Registry listening on http://0.0.0.0:${resolvedPort}`);
    console.log(`   GraphQL: http://0.0.0.0:${resolvedPort}/graphql`);
    console.log(`   REST:    http://0.0.0.0:${resolvedPort}/render`);
  });

  // Publish a startup notification so the renderer shows something immediately
  setTimeout(() => {
    console.log('📦 Registry: Publishing startup notification...');
    registry.renderComponent({
      type: 'NOTIFICATION',
      data: { message: 'Registry is active and ready!', status: 'SUCCESS' }
    });
  }, 3000);

  return registry;
}

// ESM entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  startRegistry().catch(err => {
    console.error('❌ Registry failed to start:', err);
    process.exit(1);
  });
}

export { startRegistry, ComponentRegistry };
