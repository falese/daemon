// ========================
// SIMPLE COMPONENT DAEMON
// Actually connects to registry and forwards to renderer
// ========================

const { ApolloServer } = require('apollo-server-express');
const { createServer } = require('http');
const { SubscriptionServer } = require('subscriptions-transport-ws');
const { makeExecutableSchema } = require('@graphql-tools/schema');
const { PubSub } = require('graphql-subscriptions');
const express = require('express');
const WebSocket = require('ws');

// ========================
// DAEMON
// ========================

class ComponentDaemon {
  constructor() {
    this.components = new Map(); // Maps component ID to ComponentState
    this.pubsub = new PubSub();
    this.registryWs = null;
    this.registryState = new Map(); // State shared with registry
  }

  async start() {
    // Connect to registry via WebSocket (GraphQL subscription transport)
    this.connectToRegistry();
    console.log('🚀 Daemon: Started');
  }

  connectToRegistry() {
    console.log('🔌 Daemon: Connecting to registry...');
    
    this.registryWs = new WebSocket('ws://localhost:4000/graphql', 'graphql-ws');
    
    this.registryWs.onopen = () => {
      console.log('✅ Daemon: Connected to registry');
      
      // Initialize GraphQL-WS connection
      this.registryWs.send(JSON.stringify({
        type: 'connection_init'
      }));
    };

    this.registryWs.onmessage = (event) => {
      const message = JSON.parse(event.data);
      console.log('📨 Daemon: Received message from registry:', message);
      
      if (message.type === 'connection_ack') {
        console.log('📡 Daemon: Registry connection acknowledged, starting subscription...');
        
        // Start subscription to registry
        this.registryWs.send(JSON.stringify({
          id: 'registry-sub',
          type: 'start',
          payload: {
            query: `
              subscription {
                componentUpdate {
                  id
                  type
                  data
                  createdAt
                }
              }
            `
          }
        }));
        console.log('📡 Daemon: Subscription request sent to registry');
      }
      
      if (message.type === 'data') {
        if (message.payload?.errors) {
          console.error('❌ Daemon: GraphQL subscription errors:', JSON.stringify(message.payload.errors, null, 2));
        } else if (message.payload?.data?.componentUpdate) {
          const component = message.payload.data.componentUpdate;
          console.log('📦 Daemon: Received component from registry:', component.id);
          this.handleComponentFromRegistry(component);
        }
      }

      if (message.type === 'error') {
        console.error('❌ Daemon: GraphQL error from registry:', message.payload);
      }
    };

    this.registryWs.onclose = () => {
      console.log('🔌 Daemon: Disconnected from registry');
      // Attempt to reconnect
      setTimeout(() => this.connectToRegistry(), 2000);
    };

    this.registryWs.onerror = (error) => {
      console.error('❌ Daemon: Registry connection error:', error);
    };
  }

  async handleMessage(message) {
    console.log(`📨 Daemon: Handling message of type ${message.direction}`);
    
    if (message.direction === 'ACTION') {
      return this.handleAction(message);
    } else if (message.direction === 'COMPONENT') {
      return this.handleComponent(message);
    }
  }

  async handleAction(message) {
    const action = message.payload;
    console.log(`🎯 Daemon: Handling action for component ${action.componentId}`);

    const state = this.components.get(action.componentId);
    if (state) {
      state.actions.push(action);
      state.lastUpdated = new Date().toISOString();

      // Send state update to registry
      const stateMessage = {
        direction: 'COMPONENT',
        payload: state,
        metadata: {
          acknowledged: false,
          correlationId: crypto.randomUUID(),
          error: null
        }
      };

      this.pubsub.publish('MESSAGE', { messages: stateMessage });
      return stateMessage;
    }
    return null;
  }

  async handleComponent(message) {
    const component = message.payload;
    console.log(`📦 Daemon: Handling component ${component.id}`);

    // Create or update component state
    const state = {
      component,
      actions: [],
      lastUpdated: new Date().toISOString()
    };

    this.components.set(component.id, state);

    // Forward to renderers with metadata
    const forwardMessage = {
      direction: 'COMPONENT',
      payload: component,
      metadata: {
        acknowledged: false,
        correlationId: crypto.randomUUID(),
        error: null
      }
    };

    this.pubsub.publish('MESSAGE', { messages: forwardMessage });
    return forwardMessage;
  }

  handleComponentFromRegistry(component) {
    console.log(`📦 Daemon: Forwarding component ${component.id} to renderer`);
    
    // Create component state if it doesn't exist
    if (!this.components.has(component.id)) {
      this.components.set(component.id, {
        component,
        actions: [],
        lastUpdated: new Date().toISOString()
      });
    }

    // Forward to renderer as a component message
    const message = {
      direction: 'COMPONENT',
      payload: component,
      metadata: {
        acknowledged: false,
        correlationId: crypto.randomUUID(),
        error: null
      }
    };

    this.pubsub.publish('MESSAGE', { messages: message });
  }

  getComponents() {
    return Array.from(this.components.values()).map(state => state.component);
  }

  getComponentStates() {
    return Array.from(this.components.values());
  }
}

// ========================
// GRAPHQL SCHEMA (FOR RENDERER)
// ========================

const typeDefs = `
  scalar JSON

  type Query {
    components: [Component!]!
  }

  type Mutation {
    sendMessage(message: String!): Boolean!
  }

  type Subscription {
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

function createResolvers(daemon) {
  return {
    Query: {
      components: () => daemon.getComponents()
    },

    Mutation: {
      sendMessage: async (_, { message }) => {
        const msg = JSON.parse(message);
        await daemon.handleMessage(msg);
        return true;
      }
    },

    Subscription: {
      messages: {
        subscribe: () => {
          console.log('📡 Daemon: Client subscribed to messages');
          return daemon.pubsub.asyncIterableIterator('MESSAGE');
        }
      }
    }
  };
}

// ========================
// SERVER
// ========================

async function startDaemon(port = 3001) {
  const app = express();
  const httpServer = createServer(app);
  const daemon = new ComponentDaemon();

  // Start daemon
  await daemon.start();

  // GraphQL setup
  const schema = makeExecutableSchema({
    typeDefs,
    resolvers: createResolvers(daemon)
  });

  const server = new ApolloServer({ schema });
  await server.start();
  server.applyMiddleware({ app, path: '/graphql' });

  // Subscription server
  SubscriptionServer.create(
    { schema, execute: require('graphql').execute, subscribe: require('graphql').subscribe },
    { server: httpServer, path: '/graphql' }
  );

  app.get('/', (req, res) => {
    res.json({
      message: 'Component Daemon - Real Connection',
      components: daemon.getComponents().length,
      status: 'Connected to registry'
    });
  });

  httpServer.listen(port, () => {
    console.log(`🚀 Component Daemon running on http://localhost:${port}`);
    console.log(`📡 GraphQL: http://localhost:${port}/graphql`);
  });

  return daemon;
}

if (require.main === module) {
  startDaemon();
}

module.exports = { startDaemon };