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
    this.components = new Map();
    this.pubsub = new PubSub();
    this.registryWs = null;
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

  handleComponentFromRegistry(component) {
    console.log(`📦 Daemon: Forwarding component ${component.id} to renderer`);
    
    this.components.set(component.id, component);

    // Forward to renderer
    this.pubsub.publish('RENDERER_UPDATE', {
      rendererUpdate: component
    });
  }

  getComponents() {
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

  type Subscription {
    rendererUpdate: Component!
  }

  type Component {
    id: String!
    type: ComponentType!
    data: JSON!
    createdAt: String!
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

    Subscription: {
      rendererUpdate: {
        subscribe: () => {
          console.log('📡 Daemon: Renderer subscribed to updates');
          // Use the correct method name that matches the registry
          return daemon.pubsub.asyncIterableIterator('RENDERER_UPDATE');
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