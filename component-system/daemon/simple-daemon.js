// ========================
// SIMPLE COMPONENT DAEMON (Node.js parity with Rust implementation)
// Cleaned version
// ========================

const express = require('express');
const { createServer } = require('http');
const { makeExecutableSchema } = require('@graphql-tools/schema');
const { PubSub } = require('graphql-subscriptions');
const { useServer } = require('graphql-ws/lib/use/ws');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const WebSocket = require('ws');
const GraphQLJSON = require('graphql-type-json');
const { execute, subscribe } = require('graphql');

// --- Constants / Enums ---
const WS_SUBPROTOCOL = 'graphql-transport-ws';
const MessageDirection = Object.freeze({ COMPONENT: 'COMPONENT', ACTION: 'ACTION' });
const MessageKind = Object.freeze({ COMPONENT_UPDATE: 'COMPONENT_UPDATE', STATE_SNAPSHOT: 'STATE_SNAPSHOT', ACTION_ECHO: 'ACTION_ECHO' });

// --- Component Daemon ---
class ComponentDaemon {
  constructor() {
    this.componentState = new Map(); // id -> { component, actions: [], lastUpdated }
    this.pubsub = new PubSub();
    this.registrySocket = null;
    this.registryReconnectAttempt = 0;
    this.stopping = false;
  }

  start() { this.connectToRegistry(); }

  // Registry subscription connection
  connectToRegistry() {
    if (this.stopping) return;
    const host = process.env.REGISTRY_HOST || 'registry';
    const port = process.env.REGISTRY_PORT || '4000';
    const url = `ws://${host}:${port}/graphql`;
    const ws = new WebSocket(url, WS_SUBPROTOCOL);
    this.registrySocket = ws;

    ws.onopen = () => ws.send(JSON.stringify({ type: 'connection_init' }));

    ws.onmessage = (evt) => {
      let msg; try { msg = JSON.parse(evt.data); } catch { return; }
      switch (msg.type) {
        case 'connection_ack':
          ws.send(JSON.stringify({ id: 'registry-sub', type: 'subscribe', payload: { query: 'subscription { componentUpdate { id type data createdAt } }' } }));
          break;
        case 'next': {
          const comp = msg.payload?.data?.componentUpdate; if (comp) this.handleComponentFromRegistry(comp); break; }
        case 'ping': ws.send(JSON.stringify({ type: 'pong' })); break;
      }
    };

    ws.onclose = () => {
      if (this.stopping) return;
      const delay = Math.min(5000, 400 * Math.pow(1.6, this.registryReconnectAttempt++));
      setTimeout(() => this.connectToRegistry(), delay);
    };
  }

  // Message handling entry
  async handleMessage(message) {
    if (!message || typeof message !== 'object') return null;
    if (message.direction === MessageDirection.ACTION) return this.handleAction(message);
    if (message.direction === MessageDirection.COMPONENT) return this.handleInboundComponent(message);
    return null;
  }

  async handleAction(envelope) {
    const action = envelope.payload;
    const state = this.componentState.get(action.componentId);
    if (state) { state.actions.push(action); state.lastUpdated = new Date().toISOString(); }

    // ACTION_ECHO
    const echo = this.buildMessage({
      direction: MessageDirection.ACTION,
      kind: MessageKind.ACTION_ECHO,
      payload: action,
      metadata: { acknowledged: true, correlationId: (envelope.metadata && envelope.metadata.correlationId) || action.id, error: null }
    });
    this.publish(echo);

    // STATE_SNAPSHOT
    if (state) {
      this.publish(this.buildMessage({
        direction: MessageDirection.COMPONENT,
        kind: MessageKind.STATE_SNAPSHOT,
        payload: { component: state.component, actions: state.actions, lastUpdated: state.lastUpdated }
      }));
    }

    // Forward action to registry
    this.forwardActionToRegistry(envelope).catch(()=>{});
    return echo;
  }

  async handleInboundComponent(envelope) {
    const comp = envelope.payload; if (!comp || !comp.id) return null;
    this.storeComponent(comp);
    const msg = this.buildMessage({ direction: MessageDirection.COMPONENT, kind: MessageKind.COMPONENT_UPDATE, payload: comp });
    this.publish(msg); return msg;
  }

  handleComponentFromRegistry(component) {
    if (!component || !component.id) return;
    this.storeComponent(component);
    this.publish(this.buildMessage({ direction: MessageDirection.COMPONENT, kind: MessageKind.COMPONENT_UPDATE, payload: component }));
  }

  storeComponent(component) {
    const existing = this.componentState.get(component.id);
    if (existing) { existing.component = component; existing.lastUpdated = new Date().toISOString(); }
    else this.componentState.set(component.id, { component, actions: [], lastUpdated: new Date().toISOString() });
  }

  // Fire-and-forget mutation over a short-lived WS
  async forwardActionToRegistry(envelope) {
    const host = process.env.REGISTRY_HOST || 'registry';
    const port = process.env.REGISTRY_PORT || '4000';
    const url = `ws://${host}:${port}/graphql`;
    const ws = new WebSocket(url, WS_SUBPROTOCOL);
    const timer = setTimeout(() => { try { ws.close(); } catch(_){} }, 4000);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'connection_init' }));
    ws.onmessage = (evt) => {
      let msg; try { msg = JSON.parse(evt.data); } catch { return; }
      if (msg.type === 'connection_ack') {
        ws.send(JSON.stringify({ id: 'mutation-' + uuidv4(), type: 'subscribe', payload: { query: 'mutation($message:String!){ handleMessage(message:$message) }', variables: { message: JSON.stringify(envelope) } } }));
      } else if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      else if (msg.type === 'complete') ws.close();
    };
    ws.onclose = () => clearTimeout(timer);
  }

  buildMessage({ direction, kind, payload, metadata }) {
    return { direction, kind, payload, metadata: metadata || { acknowledged: false, correlationId: uuidv4(), error: null } };
  }
  publish(message) { this.pubsub.publish('MESSAGES', { messages: message }); }
  getComponents() { return Array.from(this.componentState.values()).map(s => s.component); }
  getComponentStates() { return Array.from(this.componentState.values()); }
}

// --- GraphQL Schema ---
const typeDefs = `
  scalar JSON
  enum MessageDirection { COMPONENT ACTION }
  enum MessageKind { COMPONENT_UPDATE STATE_SNAPSHOT ACTION_ECHO }
  type MessageMetadata { acknowledged: Boolean! correlationId: String error: String }
  type Message { direction: MessageDirection! kind: MessageKind payload: JSON! metadata: MessageMetadata }
  type Component { id: String! type: String! data: JSON! createdAt: String! }
  type Action { id: String! componentId: String! actionType: String! data: JSON! timestamp: String! }
  type ComponentState { component: Component! actions: [Action!]! lastUpdated: String! }
  type Query { components: [Component!]! componentStates: [ComponentState!]! }
  type Mutation { sendMessage(message: String!): Boolean! }
  type Subscription { messages: Message! }
`;

function createResolvers(daemon) {
  return {
    JSON: GraphQLJSON,
    Query: { components: () => daemon.getComponents(), componentStates: () => daemon.getComponentStates() },
    Mutation: { sendMessage: async (_, { message }) => { let m; try { m = JSON.parse(message); } catch { throw new Error('Invalid JSON'); } await daemon.handleMessage(m); return true; } },
    Subscription: { messages: { subscribe: () => daemon.pubsub.asyncIterator('MESSAGES') } }
  };
}

// --- Server Startup ---
async function startDaemon(port = 3001) {
  const app = express();
  const httpServer = createServer(app);
  const daemon = new ComponentDaemon();
  daemon.start();

  const schema = makeExecutableSchema({ typeDefs, resolvers: createResolvers(daemon) });

  app.use(express.json());
  app.post('/graphql', async (req, res) => {
    const { query, variables, operationName } = req.body || {};
    try {
      const result = await execute({ schema, document: require('graphql').parse(query), variableValues: variables, operationName, contextValue: { daemon } });
      res.json(result);
    } catch (e) { res.status(400).json({ errors: [{ message: e.message }] }); }
  });

  app.get('/', (_req, res) => res.json({ message: 'Component Daemon (Node parity)', components: daemon.getComponents().length, status: 'running' }));

  const wsServer = new WebSocketServer({ server: httpServer, path: '/graphql' });
  useServer({ schema, execute, subscribe, context: () => ({ daemon }) }, wsServer);

  httpServer.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Component Daemon running on http://0.0.0.0:${port}`);
    console.log(`📡 GraphQL (HTTP+WS): http://0.0.0.0:${port}/graphql`);
  });

  return daemon;
}

if (require.main === module) {
  const envPort = parseInt(process.env.DAEMON_PORT || '', 10);
  const port = Number.isFinite(envPort) ? envPort : 3001; // default 3001 (renderer expectation)
  startDaemon(port).catch(err => { console.error('❌ Daemon start failed', err); process.exit(1); });
}

module.exports = { startDaemon };