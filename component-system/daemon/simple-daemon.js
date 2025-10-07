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

// Standardized logger (Node daemon) 😈
const logger = (() => {
  const icon = '😈';
  const forceJson = process.env.LOG_JSON === '1';
  function base(fields){ return Object.assign({ svc:'daemon-node', icon }, fields||{}); }
  function out(level, obj, msg){
    const rec = { ts:new Date().toISOString(), level, ...base(obj), msg };
    if (forceJson) {
      console.log(JSON.stringify(rec));
    } else {
      const main = `${rec.ts} ${icon} ${level.toUpperCase()} ${rec.code||''} ${rec.event||''}`.trim();
      const extras = Object.entries(rec)
        .filter(([k]) => !['ts','level','svc','icon','code','event','msg'].includes(k))
        .map(([k,v]) => `${k}=${v}`)
        .join(' ');
      console.log(`${main} - ${msg}${extras? ' | '+extras:''}`);
    }
  }
  return { info:(o,m)=>out('info',o,m), warn:(o,m)=>out('warn',o,m), error:(o,m)=>out('error',o,m) };
})();

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
    const directWs = process.env.REGISTRY_WS_URL; // full ws(s)://host/graphql if provided
    const host = process.env.REGISTRY_HOST || 'registry';
    const port = process.env.REGISTRY_PORT || '4000';
    const url = directWs || `ws://${host}:${port}/graphql`;
    logger.info({ code:'DAE-201', event:'WS_REGISTRY_CONNECT', url, attempt:this.registryReconnectAttempt }, 'Connecting to registry');
    const ws = new WebSocket(url, WS_SUBPROTOCOL);
    this.registrySocket = ws;

    ws.onopen = () => { logger.info({ code:'DAE-202', event:'WS_REGISTRY_OPEN', url }, 'Registry socket open'); ws.send(JSON.stringify({ type: 'connection_init' })); };

    ws.onmessage = (evt) => {
      let msg; try { msg = JSON.parse(evt.data); } catch { return; }
      switch (msg.type) {
        case 'connection_ack':
          logger.info({ code:'DAE-202', event:'WS_REGISTRY_ACK' }, 'Registry connection acknowledged');
          ws.send(JSON.stringify({ id: 'registry-sub', type: 'subscribe', payload: { query: 'subscription { componentUpdate { id type data createdAt } }' } }));
          break;
        case 'next': {
          const comp = msg.payload && msg.payload.data && msg.payload.data.componentUpdate;
          if (comp) { logger.info({ code:'DAE-210', event:'COMPONENT_FROM_REGISTRY', compId:comp.id }, 'Component from registry'); this.handleComponentFromRegistry(comp); }
          break; }
        case 'ping': logger.info({ code:'DAE-205', event:'WS_PING' }, 'Ping from registry'); ws.send(JSON.stringify({ type: 'pong' })); break;
        case 'error': logger.error({ code:'DAE-299', event:'WS_REGISTRY_ERROR', raw:JSON.stringify(msg.payload||{}) }, 'Registry WS error frame'); break;
        default: /* ignore */ break;
      }
    };

    ws.onclose = () => {
      if (this.stopping) return;
      const delay = Math.min(5000, 400 * Math.pow(1.6, this.registryReconnectAttempt++));
      logger.warn({ code:'DAE-240', event:'WS_REGISTRY_CLOSED', nextDelay:delay }, 'Registry socket closed, scheduling reconnect');
      setTimeout(() => this.connectToRegistry(), delay);
    };

    ws.onerror = (err) => {
      logger.error({ code:'DAE-299', event:'WS_REGISTRY_SOCKET_ERROR', error: err && err.message }, 'Registry socket error');
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
    logger.info({ code:'DAE-220', event:'ACTION_RECEIVED', actionId:action.id, compId:action.componentId, actionType:action.actionType }, 'Action received');
    // Normalize BUTTON_CLICK to CLICK (retain original)
    if (action.actionType === 'BUTTON_CLICK') {
      action.originalActionType = 'BUTTON_CLICK';
      action.actionType = 'CLICK';
      logger.info({ code:'DAE-224', event:'ACTION_NORMALIZED', actionId:action.id, compId:action.componentId }, 'Normalized BUTTON_CLICK to CLICK');
    }
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
    logger.info({ code:'DAE-221', event:'ACTION_ECHO_SENT', actionId:action.id, compId:action.componentId }, 'Action echo sent');

    // STATE_SNAPSHOT
    if (state) {
      this.publish(this.buildMessage({
        direction: MessageDirection.COMPONENT,
        kind: MessageKind.STATE_SNAPSHOT,
        payload: { component: state.component, actions: state.actions, lastUpdated: state.lastUpdated }
      }));
      logger.info({ code:'DAE-222', event:'STATE_SNAPSHOT_SENT', compId:action.componentId, actionsCount:state.actions.length }, 'State snapshot sent');
    }

    // Forward action to registry
    logger.info({ code:'DAE-230', event:'ACTION_FORWARD_START', actionId:action.id }, 'Forwarding action to registry');
    this.forwardActionToRegistry(envelope).catch(err=>{
      logger.error({ code:'DAE-299', event:'ACTION_FORWARD_ERROR', error:err && err.message, actionId:action.id }, 'Action forward error');
    });
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
    const opId = 'mutation-' + uuidv4();
    const ws = new WebSocket(url, WS_SUBPROTOCOL);
    const timer = setTimeout(() => { try { ws.close(); } catch(_){} }, 4000);
    ws.onopen = () => { logger.info({ code:'DAE-231', event:'ACTION_FORWARD_WS_OPEN', opId }, 'Forward WS open'); ws.send(JSON.stringify({ type: 'connection_init' })); };
    ws.onmessage = (evt) => {
      let msg; try { msg = JSON.parse(evt.data); } catch { return; }
      if (msg.type === 'connection_ack') {
        logger.info({ code:'DAE-231', event:'ACTION_FORWARD_ACK', opId }, 'Forward connection ack');
        ws.send(JSON.stringify({ id: opId, type: 'subscribe', payload: { query: 'mutation($message:String!){ handleMessage(message:$message) }', variables: { message: JSON.stringify(envelope) } } }));
      } else if (msg.type === 'ping') { logger.info({ code:'DAE-205', event:'FORWARD_WS_PING', opId }, 'Forward WS ping'); ws.send(JSON.stringify({ type: 'pong' })); }
      else if (msg.type === 'next') { logger.info({ code:'DAE-232', event:'ACTION_FORWARD_RESULT', opId }, 'Forward mutation result'); }
      else if (msg.type === 'complete') { logger.info({ code:'DAE-232', event:'ACTION_FORWARD_COMPLETE', opId }, 'Forward mutation complete'); ws.close(); }
      else if (msg.type === 'error') { logger.error({ code:'DAE-299', event:'ACTION_FORWARD_GRAPHQL_ERROR', opId, raw:JSON.stringify(msg.payload||{}) }, 'Forward GraphQL error'); }
    };
    ws.onclose = () => { clearTimeout(timer); logger.info({ code:'DAE-232', event:'ACTION_FORWARD_WS_CLOSE', opId }, 'Forward WS closed'); };
    ws.onerror = (err) => { logger.error({ code:'DAE-299', event:'ACTION_FORWARD_WS_ERROR', opId, error: err && err.message }, 'Forward WS socket error'); };
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
  const resolvedPort = parseInt(process.env.PORT || String(port), 10) || port;
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
  useServer({ schema, execute, subscribe, context: () => ({ daemon }),
    onConnect: () => logger.info({ code:'DAE-201', event:'WS_RENDERER_CONNECT' }, 'Renderer connected'),
    onSubscribe: () => logger.info({ code:'DAE-201', event:'WS_RENDERER_SUBSCRIBE' }, 'Renderer subscription'),
    onError: (_ctx,_msg,errors) => logger.error({ code:'DAE-299', event:'WS_RENDERER_ERROR', errors: (errors||[]).map(e=>e.message).join(';') }, 'Renderer WS error'),
    onComplete: (_ctx,_msg) => logger.info({ code:'DAE-240', event:'WS_RENDERER_COMPLETE' }, 'Renderer operation complete')
  }, wsServer);

  httpServer.listen(resolvedPort, '0.0.0.0', () => {
    logger.info({ code:'DAE-200', event:'STARTUP', port:resolvedPort }, 'Daemon listening');
    logger.info({ code:'DAE-201', event:'WS_REGISTRY_CONNECT_TARGET', registryHost: process.env.REGISTRY_HOST||'registry', registryPort: process.env.REGISTRY_PORT||'4000' }, 'Target registry');
  });

  return daemon;
}

if (require.main === module) {
  const envPort = parseInt(process.env.DAEMON_PORT || process.env.PORT || '', 10);
  const port = Number.isFinite(envPort) ? envPort : 3001;
  startDaemon(port).catch(err => { console.error('❌ Daemon start failed', err); process.exit(1); });
}

module.exports = { startDaemon };