// ========================
// COMPONENT DAEMON (Node.js)
// ========================
// Role in the system:
//   - Connects to the Registry via a persistent GraphQL-WS subscription and
//     receives component updates as they are published
//   - Exposes a GraphQL-WS server so renderers can subscribe to live updates
//   - Receives actions from renderers, acknowledges them, and forwards them to
//     the Registry where rule evaluation happens
//
// Communication pattern:
//   Registry → Daemon  : persistent WS subscription (component updates)
//   Daemon   → Registry: short-lived WS mutation connection per action
//                        (fire-and-forget — see forwardActionToRegistry)
//   Renderer → Daemon  : GraphQL mutation (sendMessage)
//   Daemon   → Renderer: GraphQL-WS subscription (messages)

const { parse }      = require('graphql');
const express        = require('express');
const { createServer } = require('http');
const { makeExecutableSchema } = require('@graphql-tools/schema');
const { PubSub }     = require('graphql-subscriptions');
const { useServer }  = require('graphql-ws/lib/use/ws');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const WebSocket      = require('ws');
const GraphQLJSON    = require('graphql-type-json');
const { execute, subscribe } = require('graphql');

// ── Constants ─────────────────────────────────────────────────────────────────

const WS_SUBPROTOCOL = 'graphql-transport-ws';

// Reconnect backoff: delay = min(MAX, BASE * FACTOR^attempt)
const RECONNECT_BASE_MS   = 400;
const RECONNECT_MAX_MS    = 5000;
const RECONNECT_FACTOR    = 1.6; // exponential growth rate

// How long to wait for the Registry to respond to a forwarded action
const FORWARD_TIMEOUT_MS  = 4000;

const MessageDirection = Object.freeze({ COMPONENT: 'COMPONENT', ACTION: 'ACTION' });
const MessageKind      = Object.freeze({
  COMPONENT_UPDATE: 'COMPONENT_UPDATE',
  STATE_SNAPSHOT:   'STATE_SNAPSHOT',
  ACTION_ECHO:      'ACTION_ECHO'
});

// ── Logger ────────────────────────────────────────────────────────────────────
// Structured logger with optional JSON output (set LOG_JSON=1).
// Each call takes a fields object and a human-readable message string.

const LOG_JSON = process.env.LOG_JSON === '1';

function logOut(level, fields, msg) {
  const record = { ts: new Date().toISOString(), level, svc: 'daemon-node', ...fields, msg };
  if (LOG_JSON) {
    console.log(JSON.stringify(record));
    return;
  }
  const prefix  = `${record.ts} 😈 ${level.toUpperCase()} ${record.code || ''} ${record.event || ''}`.trimEnd();
  const extras  = Object.entries(record)
    .filter(([k]) => !['ts', 'level', 'svc', 'code', 'event', 'msg'].includes(k))
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  console.log(`${prefix} — ${msg}${extras ? ' | ' + extras : ''}`);
}

const logger = {
  info:  (fields, msg) => logOut('info',  fields, msg),
  warn:  (fields, msg) => logOut('warn',  fields, msg),
  error: (fields, msg) => logOut('error', fields, msg)
};

// ========================
// COMPONENT DAEMON
// ========================

class ComponentDaemon {
  constructor() {
    this.componentState = new Map(); // id -> { component, actions: [], lastUpdated }
    this.slotAssignments = new Map(); // parentId -> Map<slotName, childId | null>
    this.pubsub = new PubSub();
    this.registrySocket = null;
    this.registryReconnectAttempt = 0;
    this.stopping = false;
  }

  start() {
    this.connectToRegistry();
  }

  // ── Registry connection (persistent subscription) ──────────────────────────
  // Establishes a WebSocket to the Registry and subscribes to componentUpdate.
  // On disconnect, retries with exponential backoff.

  connectToRegistry() {
    if (this.stopping) return;

    const url = process.env.REGISTRY_WS_URL ||
      `ws://${process.env.REGISTRY_HOST || 'registry'}:${process.env.REGISTRY_PORT || '4000'}/graphql`;

    logger.info({ code: 'DAE-201', event: 'WS_REGISTRY_CONNECT', url, attempt: this.registryReconnectAttempt },
      'Connecting to registry');

    const ws = new WebSocket(url, WS_SUBPROTOCOL);
    this.registrySocket = ws;

    ws.onopen = () => {
      logger.info({ code: 'DAE-202', event: 'WS_REGISTRY_OPEN' }, 'Registry socket open');
      this.registryReconnectAttempt = 0; // reset on successful connect
      ws.send(JSON.stringify({ type: 'connection_init' }));
    };

    ws.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); }
      catch (e) { logger.warn({ code: 'DAE-299', event: 'WS_PARSE_ERROR' }, 'Failed to parse registry message: ' + e.message); return; }

      switch (msg.type) {
        case 'connection_ack':
          logger.info({ code: 'DAE-202', event: 'WS_REGISTRY_ACK' }, 'Registry acknowledged — subscribing to componentUpdate');
          ws.send(JSON.stringify({
            id: 'registry-sub',
            type: 'subscribe',
            payload: { query: 'subscription { componentUpdate { id type data createdAt slots } }' }
          }));
          break;

        case 'next': {
          const comp = msg.payload?.data?.componentUpdate;
          if (comp) {
            logger.info({ code: 'DAE-210', event: 'COMPONENT_FROM_REGISTRY', compId: comp.id }, 'Received component from registry');
            this.handleComponentFromRegistry(comp);
          }
          break;
        }

        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }));
          break;

        case 'error':
          logger.error({ code: 'DAE-299', event: 'WS_REGISTRY_ERROR', payload: JSON.stringify(msg.payload || {}) },
            'Registry sent error frame');
          break;

        default:
          // connection_ack, complete, etc. — no action needed
          break;
      }
    };

    ws.onclose = () => {
      if (this.stopping) return;
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(RECONNECT_FACTOR, this.registryReconnectAttempt++));
      logger.warn({ code: 'DAE-240', event: 'WS_REGISTRY_CLOSED', retryMs: delay }, 'Registry socket closed — will retry');
      setTimeout(() => this.connectToRegistry(), delay);
    };

    ws.onerror = (err) => {
      logger.error({ code: 'DAE-299', event: 'WS_REGISTRY_ERROR', error: err?.message }, 'Registry socket error');
    };
  }

  // ── Message dispatch ───────────────────────────────────────────────────────

  async handleMessage(message) {
    if (!message || typeof message !== 'object') return null;
    if (message.direction === MessageDirection.ACTION)    return this.handleAction(message);
    if (message.direction === MessageDirection.COMPONENT) return this.handleInboundComponent(message);
    return null;
  }

  // ── Action handling ────────────────────────────────────────────────────────
  // When a renderer sends an action:
  //   1. Normalize action type (BUTTON_CLICK → CLICK)
  //   2. Record action in local state
  //   3. Send ACTION_ECHO back to the renderer (immediate acknowledgement)
  //   4. Send STATE_SNAPSHOT back to the renderer (current component state)
  //   5. Forward the action to the Registry for rule evaluation (fire-and-forget)

  async handleAction(envelope) {
    // Step 1: Normalise — create a new object so the original is not mutated
    const raw    = envelope.payload;
    const action = raw.actionType === 'BUTTON_CLICK'
      ? { ...raw, actionType: 'CLICK', originalActionType: 'BUTTON_CLICK' }
      : raw;

    if (action !== raw) {
      logger.info({ code: 'DAE-224', event: 'ACTION_NORMALIZED', actionId: action.id },
        'BUTTON_CLICK normalised to CLICK');
    }

    logger.info({ code: 'DAE-220', event: 'ACTION_RECEIVED', actionId: action.id, compId: action.componentId, actionType: action.actionType },
      'Action received from renderer');

    // Step 2: Record in local state
    const state = this.componentState.get(action.componentId);
    if (state) {
      state.actions.push(action);
      state.lastUpdated = new Date().toISOString();
    }

    // Step 3: Echo — confirms the daemon received the action
    const correlationId = envelope.metadata?.correlationId || action.id;
    const echo = this.buildMessage({
      direction: MessageDirection.ACTION,
      kind: MessageKind.ACTION_ECHO,
      payload: action,
      metadata: { acknowledged: true, correlationId, error: null }
    });
    this.publish(echo);
    logger.info({ code: 'DAE-221', event: 'ACTION_ECHO_SENT', actionId: action.id }, 'Action echo sent');

    // Step 4: Snapshot — gives the renderer the full current state of this component
    if (state) {
      this.publish(this.buildMessage({
        direction: MessageDirection.COMPONENT,
        kind: MessageKind.STATE_SNAPSHOT,
        payload: { component: state.component, actions: state.actions, lastUpdated: state.lastUpdated }
      }));
      logger.info({ code: 'DAE-222', event: 'STATE_SNAPSHOT_SENT', compId: action.componentId },
        'State snapshot sent');
    }

    // Step 5: Forward to registry (fire-and-forget — do not await)
    logger.info({ code: 'DAE-230', event: 'ACTION_FORWARD_START', actionId: action.id }, 'Forwarding action to registry');
    this.forwardActionToRegistry({ ...envelope, payload: action }).catch(err => {
      logger.error({ code: 'DAE-299', event: 'ACTION_FORWARD_ERROR', actionId: action.id, error: err?.message },
        'Action forward failed');
    });

    return echo;
  }

  // ── Inbound component from renderer (COMPONENT direction message) ──────────

  handleInboundComponent(envelope) {
    const comp = envelope.payload;
    if (!comp || !comp.id) return null;
    this.storeComponent(comp);
    const msg = this.buildMessage({ direction: MessageDirection.COMPONENT, kind: MessageKind.COMPONENT_UPDATE, payload: comp });
    this.publish(msg);
    return msg;
  }

  // ── Inbound component from Registry subscription ───────────────────────────

  handleComponentFromRegistry(component) {
    if (!component || !component.id) return;
    this.storeComponent(component);
    this.publish(this.buildMessage({
      direction: MessageDirection.COMPONENT,
      kind: MessageKind.COMPONENT_UPDATE,
      payload: component
    }));
  }

  // ── Local state ────────────────────────────────────────────────────────────

  storeComponent(component) {
    const existing = this.componentState.get(component.id);
    if (existing) {
      existing.component   = component;
      existing.lastUpdated = new Date().toISOString();
    } else {
      this.componentState.set(component.id, {
        component,
        actions:     [],
        lastUpdated: new Date().toISOString()
      });
    }
    this.resolveSlotAssignment(component);
  }

  // ── Slot composition ───────────────────────────────────────────────────────
  // The daemon owns the slot map. Components declare slot names; Registry rules
  // express intent via data._slot; the daemon enforces and broadcasts assignments.

  resolveSlotAssignment(component) {
    const directive = component.data?._slot;
    if (!directive?.parentId || !directive?.slotName) return;

    const parent = this.componentState.get(directive.parentId)?.component;
    if (!parent?.slots?.includes(directive.slotName)) return;

    if (!this.slotAssignments.has(directive.parentId))
      this.slotAssignments.set(directive.parentId, new Map());
    this.slotAssignments.get(directive.parentId).set(directive.slotName, component.id);

    logger.info(
      { code: 'DAE-250', event: 'SLOT_ASSIGNED', parentId: directive.parentId, slotName: directive.slotName, childId: component.id },
      'Slot assignment resolved'
    );
    this.publishSlotAssignment(directive.parentId, directive.slotName, component.id);
  }

  publishSlotAssignment(parentComponentId, slotName, childComponentId) {
    const assignment = { parentComponentId, slotName, childComponentId };
    this.publish(this.buildMessage({
      direction: MessageDirection.COMPONENT,
      kind:      'SLOT_ASSIGNMENT',
      payload:   assignment
    }));
  }

  assignSlot(parentId, slotName, childId) {
    const parent = this.componentState.get(parentId)?.component;
    if (!parent?.slots?.includes(slotName)) return false;

    if (!this.slotAssignments.has(parentId))
      this.slotAssignments.set(parentId, new Map());
    this.slotAssignments.get(parentId).set(slotName, childId ?? null);

    logger.info(
      { code: 'DAE-251', event: 'SLOT_ASSIGNED_EXPLICIT', parentId, slotName, childId },
      'Explicit slot assignment'
    );
    this.publishSlotAssignment(parentId, slotName, childId ?? null);
    return true;
  }

  getSlotAssignments() {
    const result = [];
    for (const [parentId, slots] of this.slotAssignments) {
      for (const [slotName, childId] of slots) {
        result.push({ parentComponentId: parentId, slotName, childComponentId: childId });
      }
    }
    return result;
  }

  // ── Forward action to Registry ─────────────────────────────────────────────
  // Opens a short-lived WebSocket, sends the handleMessage mutation, then
  // closes. We use a new connection per action rather than the persistent
  // subscription socket because GraphQL-WS multiplexes operations by ID and
  // reusing the subscription socket for mutations requires careful ID tracking.
  // The simpler and safer approach is a dedicated connection per mutation.

  async forwardActionToRegistry(envelope) {
    const host = process.env.REGISTRY_HOST || 'registry';
    const port = process.env.REGISTRY_PORT || '4000';
    const url  = process.env.REGISTRY_WS_URL || `ws://${host}:${port}/graphql`;
    const opId = 'fwd-' + uuidv4();
    const ws   = new WebSocket(url, WS_SUBPROTOCOL);

    // Safety net: close the connection if the registry doesn't respond in time
    const timer = setTimeout(() => {
      logger.warn({ code: 'DAE-231', event: 'ACTION_FORWARD_TIMEOUT', opId }, 'Forward timed out — closing WS');
      try { ws.close(); } catch (_) { /* already closed */ }
    }, FORWARD_TIMEOUT_MS);

    ws.onopen = () => {
      logger.info({ code: 'DAE-231', event: 'ACTION_FORWARD_WS_OPEN', opId }, 'Forward WS open');
      ws.send(JSON.stringify({ type: 'connection_init' }));
    };

    ws.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }

      switch (msg.type) {
        case 'connection_ack':
          logger.info({ code: 'DAE-231', event: 'ACTION_FORWARD_ACK', opId }, 'Forward WS acknowledged');
          ws.send(JSON.stringify({
            id: opId,
            type: 'subscribe',
            payload: {
              query: 'mutation($message: String!) { handleMessage(message: $message) }',
              variables: { message: JSON.stringify(envelope) }
            }
          }));
          break;
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }));
          break;
        case 'next':
          logger.info({ code: 'DAE-232', event: 'ACTION_FORWARD_RESULT', opId }, 'Registry handled the action');
          break;
        case 'complete':
          logger.info({ code: 'DAE-232', event: 'ACTION_FORWARD_COMPLETE', opId }, 'Forward mutation complete');
          ws.close();
          break;
        case 'error':
          logger.error({ code: 'DAE-299', event: 'ACTION_FORWARD_GQL_ERROR', opId, payload: JSON.stringify(msg.payload || {}) },
            'Registry returned GraphQL error');
          break;
      }
    };

    ws.onclose = () => {
      clearTimeout(timer);
      logger.info({ code: 'DAE-232', event: 'ACTION_FORWARD_WS_CLOSE', opId }, 'Forward WS closed');
    };

    ws.onerror = (err) => {
      logger.error({ code: 'DAE-299', event: 'ACTION_FORWARD_WS_ERROR', opId, error: err?.message },
        'Forward WS socket error');
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  buildMessage({ direction, kind, payload, metadata }) {
    return {
      direction,
      kind,
      payload,
      metadata: metadata || { acknowledged: false, correlationId: uuidv4(), error: null }
    };
  }

  publish(message) {
    this.pubsub.publish('MESSAGES', { messages: message });
  }

  getComponents() {
    return Array.from(this.componentState.values()).map(s => s.component);
  }

  getComponentStates() {
    return Array.from(this.componentState.values());
  }
}

// ========================
// GRAPHQL SCHEMA
// ========================

const typeDefs = `
  scalar JSON

  # Direction tells consumers whether this message is about a component
  # flowing down (COMPONENT) or an action flowing up (ACTION)
  enum MessageDirection { COMPONENT ACTION }

  # Kind refines the message type within each direction
  enum MessageKind { COMPONENT_UPDATE STATE_SNAPSHOT ACTION_ECHO SLOT_ASSIGNMENT }

  type MessageMetadata {
    acknowledged: Boolean!
    correlationId: String
    error: String
  }

  type Message {
    direction: MessageDirection!
    kind:      MessageKind
    payload:   JSON!
    metadata:  MessageMetadata
  }

  type Component {
    id:        String!
    type:      String!
    data:      JSON!
    createdAt: String!
    slots:     [String!]
  }

  type SlotAssignment {
    parentComponentId: String!
    slotName:          String!
    childComponentId:  String
  }

  type Action {
    id:         String!
    componentId: String!
    actionType: String!
    data:       JSON!
    timestamp:  String!
  }

  type ComponentState {
    component:   Component!
    actions:     [Action!]!
    lastUpdated: String!
  }

  type Query {
    components:      [Component!]!
    componentStates: [ComponentState!]!
    slotAssignments: [SlotAssignment!]!
  }

  type Mutation {
    # Accepts a JSON-serialised message envelope (direction + payload).
    # Used by renderers to send user actions up to the daemon.
    sendMessage(message: String!): Boolean!
    # Explicitly assign a child component to a named slot on a parent component.
    # childId may be omitted or null to clear the slot.
    assignSlot(parentId: String!, slotName: String!, childId: String): Boolean!
  }

  type Subscription {
    # Renderers subscribe here to receive real-time component updates,
    # action echoes, and state snapshots.
    messages: Message!
  }
`;

// ========================
// RESOLVERS
// ========================

function createResolvers(daemon) {
  return {
    JSON: GraphQLJSON,

    Query: {
      components:      () => daemon.getComponents(),
      componentStates: () => daemon.getComponentStates(),
      slotAssignments: () => daemon.getSlotAssignments()
    },

    Mutation: {
      sendMessage: async (_, { message }) => {
        let parsed;
        try { parsed = JSON.parse(message); }
        catch { throw new Error('sendMessage: message must be a valid JSON string'); }
        await daemon.handleMessage(parsed);
        return true;
      },
      assignSlot: (_, { parentId, slotName, childId }) =>
        daemon.assignSlot(parentId, slotName, childId ?? null)
    },

    Subscription: {
      messages: {
        subscribe: () => daemon.pubsub.asyncIterator('MESSAGES')
      }
    }
  };
}

// ========================
// SERVER STARTUP
// ========================

async function startDaemon(port = 3001) {
  const resolvedPort = parseInt(process.env.PORT || String(port), 10) || port;
  const app          = express();
  const httpServer   = createServer(app);
  const daemon       = new ComponentDaemon();

  daemon.start();

  const schema = makeExecutableSchema({ typeDefs, resolvers: createResolvers(daemon) });

  app.use(express.json());

  // HTTP POST /graphql — handles queries and mutations over plain HTTP
  app.post('/graphql', async (req, res) => {
    const { query, variables, operationName } = req.body || {};
    try {
      const result = await execute({ schema, document: parse(query), variableValues: variables, operationName, contextValue: { daemon } });
      res.json(result);
    } catch (e) {
      res.status(400).json({ errors: [{ message: e.message }] });
    }
  });

  // Health check
  app.get('/', (_req, res) => res.json({
    service:    'control-plane-daemon',
    components: daemon.getComponents().length,
    status:     'running'
  }));

  // WebSocket server — subscriptions use graphql-transport-ws protocol
  const wsServer = new WebSocketServer({ server: httpServer, path: '/graphql' });
  useServer({
    schema,
    execute,
    subscribe,
    context: () => ({ daemon }),
    onConnect:    ()            => logger.info({ code: 'DAE-201', event: 'WS_RENDERER_CONNECT' },    'Renderer connected'),
    onError:      (_c, _m, err) => logger.error({ code: 'DAE-299', event: 'WS_RENDERER_ERROR',
                                    errors: (err || []).map(e => e.message).join('; ') },             'Renderer WS error'),
    onDisconnect: ()            => logger.info({ code: 'DAE-240', event: 'WS_RENDERER_DISCONNECT' }, 'Renderer disconnected')
  }, wsServer);

  httpServer.listen(resolvedPort, '0.0.0.0', () => {
    logger.info({ code: 'DAE-200', event: 'STARTUP', port: resolvedPort }, 'Daemon listening');
    logger.info({
      code: 'DAE-201', event: 'REGISTRY_TARGET',
      host: process.env.REGISTRY_HOST || 'registry',
      port: process.env.REGISTRY_PORT || '4000'
    }, 'Will connect to registry');
  });

  return daemon;
}

if (require.main === module) {
  const envPort = parseInt(process.env.DAEMON_PORT || process.env.PORT || '', 10);
  const port    = Number.isFinite(envPort) ? envPort : 3001;
  startDaemon(port).catch(err => {
    console.error('❌ Daemon start failed:', err);
    process.exit(1);
  });
}

module.exports = { startDaemon };
