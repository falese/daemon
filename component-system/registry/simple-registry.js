// ========================
// SIMPLE COMPONENT REGISTRY
// Backend that publishes components via GraphQL subscription
// ========================


import { ApolloServer } from 'apollo-server-express';
import { createServer } from 'http';
import { useServer } from 'graphql-ws/use/ws';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { PubSub } from 'graphql-subscriptions';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { execute, subscribe } from 'graphql';
import { WebSocketServer } from 'ws';

// ========================
// REGISTRY
// ========================

class ComponentRegistry {
  constructor() {
    this.components = new Map(); // Stores current component states
    this.rules = new Map(); // Stores component generation rules
    this.pubsub = new PubSub();
    
    // Initialize default rules
    this.setupDefaultRules();
  }

  setupDefaultRules() {
    // Rule: When a card receives a 'click' action, create a notification
    this.rules.set('card-click', {
      condition: (state, action) => 
        state.component.type === 'CARD' && 
        action.actionType === 'CLICK',
      generate: (state, action) => ({
        type: 'NOTIFICATION',
        data: {
          message: `Card ${state.component.id} was clicked!`,
          type: 'INFO'
        }
      })
    });

    // Rule: When a form is submitted, create a card with the form data
    this.rules.set('form-submit', {
      condition: (state, action) =>
        state.component.type === 'FORM' &&
        action.actionType === 'SUBMIT',
      generate: (state, action) => ({
        type: 'CARD',
        data: {
          title: 'Form Submission',
          content: JSON.stringify(action.data),
          timestamp: new Date().toISOString()
        }
      })
    });
  }

  handleMessage(message) {
    console.log(`📨 Registry: Handling message of type ${message.direction}`);
    
    if (message.direction === 'ACTION') {
      return this.handleAction(message);
    } else if (message.direction === 'COMPONENT') {
      return this.updateComponentState(message);
    }
  }

  async handleAction(message) {
    const action = message.payload;
    console.log(`🎯 Registry: Processing action for component ${action.componentId}`);

    const state = this.components.get(action.componentId);
    if (!state) {
      console.warn(`⚠️ Registry: No state found for component ${action.componentId} (cannot evaluate rules)`);
      return null;
    }

    console.log(`🧪 Registry: Evaluating rules for component type=${state.component.type} actionType=${action.actionType}`);
    let triggered = false;
    for (const [ruleName, rule] of this.rules) {
      let conditionResult = false;
      try {
        conditionResult = rule.condition(state, action);
      } catch (e) {
        console.error(`❌ Registry: Rule '${ruleName}' threw error:`, e);
      }
      console.log(`🔍 Registry: Rule '${ruleName}' condition => ${conditionResult}`);
      if (conditionResult) {
        triggered = true;
        console.log(`✨ Registry: Rule '${ruleName}' triggered`);
        const componentSpec = rule.generate(state, action);
        await this.renderComponent(componentSpec);
      }
    }
    if (!triggered) {
      console.log(`🚫 Registry: No rules triggered for actionType=${action.actionType} on component ${action.componentId}`);
    }

    return true;
  }

  updateComponentState(message) {
    const state = message.payload;
    console.log(`📝 Registry: Updating state for component ${state.component.id}`);
    this.components.set(state.component.id, state);
    return true;
  }

  renderComponent({ type, data }) {
    const component = {
      id: uuidv4(),
      type,
      data,
      createdAt: new Date().toISOString()
    };

    // Initialize component state
    const state = {
      component,
      actions: [],
      lastUpdated: new Date().toISOString()
    };

    this.components.set(component.id, state);
    console.log(`📦 Registry: Publishing new component ${component.id}`);

    // Publish as a component message
    const message = {
      direction: 'COMPONENT',
      payload: component,
      metadata: {
        acknowledged: false,
        correlationId: uuidv4(),
        error: null
      }
    };

    this.pubsub.publish('COMPONENT_UPDATE', {
      componentUpdate: component
    });

    return component;
  }

  getComponents() {
    return Array.from(this.components.values()).map(state => state.component);
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
    renderComponent(type: ComponentType!, data: JSON!): Component!
    handleMessage(message: String!): Boolean!
  }

  type Subscription {
    componentUpdate: Component!
    messages: Message!
  }

  type Message {
    direction: MessageDirection!
    payload: JSON!
    metadata: MessageMetadata
  }

  enum MessageDirection {
    COMPONENT
    ACTION
  }

  type MessageMetadata {
    acknowledged: Boolean!
    correlationId: String
    error: String
  }

  type Component {
    id: String!
    type: ComponentType!
    data: JSON!
    createdAt: String!
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
      renderComponent: (_, { type, data }) => {
        console.log(`🎨 Registry GraphQL: Rendering ${type} component`);
        return registry.renderComponent({ type, data });
      },
      handleMessage: async (_, { message }) => {
        console.log(`📨 Registry GraphQL: Handling message`);
        const msg = JSON.parse(message);
        return registry.handleMessage(msg);
      }
    },

    Subscription: {
      componentUpdate: {
        subscribe: () => registry.pubsub.asyncIterableIterator('COMPONENT_UPDATE')
      },
      messages: {
        subscribe: () => {
          console.log('📡 Registry: Client subscribed to messages');
          return registry.pubsub.asyncIterableIterator('MESSAGE');
        }
      }
    }
  };
}

// ========================
// SERVER
// ========================

async function startRegistry(port = 4000) {
  const app = express();
  const httpServer = createServer(app);
  const registry = new ComponentRegistry();

  app.use(express.json());

  // REST endpoint for testing
  app.post('/render', (req, res) => {
    console.log('📨 Registry REST: Received render request', req.body);
    const { type, data } = req.body;
    const component = registry.renderComponent({ type, data });
    res.json({ success: true, component });
  });

  // Debug endpoint to test subscription
  app.post('/test-subscription', (req, res) => {
    console.log('🧪 Registry: Testing subscription publish...');
    registry.pubsub.publish('COMPONENT_UPDATE', {
      componentUpdate: {
        id: 'test-' + Date.now(),
        type: 'NOTIFICATION',
        data: { message: 'Test message from debug endpoint' },
        createdAt: new Date().toISOString()
      }
    });
    res.json({ message: 'Test subscription event published' });
  });

  // Health check
  app.get('/', (req, res) => {
    res.json({
      message: 'Component Registry',
      components: registry.getComponents().length,
      endpoints: {
        'GraphQL': '/graphql',
        'REST': '/render'
      }
    });
  });

  // GraphQL setup
  const schema = makeExecutableSchema({
    typeDefs,
    resolvers: createResolvers(registry)
  });

  const server = new ApolloServer({ 
    schema,
    context: () => ({ registry })
  });
  
  await server.start();
  server.applyMiddleware({ app, path: '/graphql' });

  // Modern graphql-ws server (supports queries/mutations/subscriptions over WS)
  const wsServer = new WebSocketServer({
    server: httpServer,
    path: '/graphql'
  });
  wsServer.on('connection', (socket, req) => {
    console.log('🔌 Registry: WS raw protocols header:', req.headers['sec-websocket-protocol']);
    socket.on('message', (data, isBinary) => {
      try {
        const text = isBinary ? data : data.toString();
        console.log('🛰️ Registry: WS raw message received:', text);
      } catch (e) {
        console.error('❌ Registry: Error logging raw message', e);
      }
    });
    socket.on('close', (code, reason) => {
      console.log(`🔌 Registry: WS connection closed code=${code} reason=${reason}`);
    });
    socket.on('error', (err) => {
      console.error('❌ Registry: WS socket error', err);
    });
  });
  useServer({
    schema,
    context: () => ({ registry }),
    onConnect: (ctx) => {
      console.log('🔌 Registry: Client connected (graphql transport)', ctx.extra.request.headers['sec-websocket-protocol']);
    },
    onDisconnect: () => {
      console.log('🔌 Registry: Client disconnected (graphql transport)');
    },
    onSubscribe: (ctx, msg) => {
      console.log('📡 Registry: onSubscribe payload:', JSON.stringify(msg));
    },
    onNext: (ctx, msg, args, result) => {
      console.log('📡 Registry: onNext sending result');
    },
    onError: (ctx, msg, errors) => {
      console.error('❌ Registry: onError', errors);
    },
    onComplete: (ctx, msg) => {
      console.log('📡 Registry: onComplete for operation', msg.id);
    }
  }, wsServer);

  httpServer.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Component Registry running on http://0.0.0.0:${port}`);
    console.log(`📡 GraphQL: http://0.0.0.0:${port}/graphql`);
    console.log(`🔌 REST: http://0.0.0.0:${port}/render`);
  });

  // Send a test component after startup
  setTimeout(() => {
    console.log('📦 Registry: Sending startup test component...');
    registry.renderComponent({
      type: 'NOTIFICATION',
      data: {
        message: 'Registry is active and ready!',
        type: 'SUCCESS'
      }
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

export { startRegistry };