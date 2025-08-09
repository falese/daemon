// ========================
// SIMPLE COMPONENT REGISTRY
// Backend that publishes components via GraphQL subscription
// ========================

const { ApolloServer } = require('apollo-server-express');
const { createServer } = require('http');
const { SubscriptionServer } = require('subscriptions-transport-ws');
const { makeExecutableSchema } = require('@graphql-tools/schema');
const { PubSub } = require('graphql-subscriptions');
const express = require('express');
const { v4: uuidv4 } = require('uuid');

// ========================
// REGISTRY
// ========================

class ComponentRegistry {
  constructor() {
    this.components = new Map();
    // Create PubSub instance properly
    this.pubsub = new PubSub();
  }

  renderComponent({ type, data }) {
    const component = {
      id: uuidv4(),
      type,
      data,
      createdAt: new Date().toISOString()
    };

    this.components.set(component.id, component);
    console.log(`📦 Registry: Publishing component ${component.id} via GraphQL subscription`);

    // THIS IS THE KEY - Publish to GraphQL subscription
    this.pubsub.publish('COMPONENT_UPDATE', {
      componentUpdate: component
    });

    return component;
  }

  getComponents() {
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
  }

  type Mutation {
    renderComponent(type: ComponentType!, data: JSON!): Component!
  }

  type Subscription {
    componentUpdate: Component!
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

function createResolvers(registry) {
  return {
    Query: {
      components: () => registry.getComponents()
    },

    Mutation: {
      renderComponent: (_, { type, data }) => {
        console.log(`🎨 Registry GraphQL: Rendering ${type} component`);
        return registry.renderComponent({ type, data });
      }
    },

    Subscription: {
      componentUpdate: {
        // Use the pubsub instance directly without trying to access it through context
        subscribe: () => registry.pubsub.asyncIterableIterator('COMPONENT_UPDATE')
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

  // GraphQL Subscription server - THIS IS CRITICAL
  SubscriptionServer.create(
    { 
      schema, 
      execute: require('graphql').execute, 
      subscribe: require('graphql').subscribe,
      onConnect: () => {
        console.log('🔌 Registry: Client connected to subscription server');
      },
      onDisconnect: () => {
        console.log('🔌 Registry: Client disconnected from subscription server');
      }
    },
    { server: httpServer, path: '/graphql' }
  );

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

if (require.main === module) {
  startRegistry();
}

module.exports = { startRegistry };