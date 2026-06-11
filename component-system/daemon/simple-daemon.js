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

// Component types that carry canonical control-plane payloads over the legacy
// envelope during migration (ADR-054 / PLATFORM-CONTRACT v3.2).
const RESOLUTION_COMPONENT_TYPE       = 'RESOLUTION';
const EXPERIENCE_COMPONENT_TYPE       = 'EXPERIENCE';
const RESOLUTION_ERROR_COMPONENT_TYPE = 'RESOLUTION_ERROR';

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
    this.pubsub = new PubSub();
    this.registrySocket = null;
    this.registryReconnectAttempt = 0;
    this.stopping = false;

    // Resolution pipeline state (ADR-054 / PLATFORM-CONTRACT v3.2):
    this.sessions          = new Map(); // sessionId -> SessionContext from the last action that carried one
    this.activeResolutions = new Map(); // sessionKey -> { mfe, capability } driving render-vs-refresh
    this.loadedMfes        = new Set(); // MFE names whose load() has completed (load runs once per MFE)
    this.mfeDirectory      = new Map(); // mfeName -> MfeRegistration, synced from the registry's GET /mfes
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
            payload: { query: 'subscription { componentUpdate { id type data createdAt } }' }
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

    // Step 1b: Capture session context. Later RESOLUTION components only
    // carry a sessionId — the daemon rehydrates the full SessionContext
    // (user, jwt, application, locale) when invoking the resolved MFE.
    if (action.context && action.context.sessionId) {
      this.sessions.set(action.context.sessionId, action.context);
    }

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
  // Two cases (ADR-054 / PLATFORM-CONTRACT v3.2):
  //   RESOLUTION component → run the resolution pipeline (authorize →
  //   load/render/refresh the resolved MFE → relay its experience)
  //   anything else → store-then-broadcast (EXPERIENCE passthrough + legacy)

  handleComponentFromRegistry(component) {
    if (!component || !component.id) return;

    if (component.type === RESOLUTION_COMPONENT_TYPE && component.data && component.data.mfe) {
      this.handleResolution(component.data).catch(err => {
        logger.error({ code: 'DAE-299', event: 'RESOLUTION_ERROR', mfe: component.data.mfe, error: err?.message },
          'Resolution pipeline failed');
      });
      return;
    }

    this.storeComponent(component);
    this.publish(this.buildMessage({
      direction: MessageDirection.COMPONENT,
      kind: MessageKind.COMPONENT_UPDATE,
      payload: component
    }));
  }

  // ── Resolution pipeline ─────────────────────────────────────────────────────
  // JS port of DaemonService.handleResolution in @control-plane/contracts —
  // the order is a protocol invariant: lookup → authorize → (load once) →
  // render | refresh → relay the RenderedExperience as an EXPERIENCE component.

  async handleResolution(data) {
    const { mfe, capability, props } = data;
    const correlationId = data.correlationId || uuidv4();
    const sessionKey    = data.sessionId || 'default';
    const session       = data.sessionId ? this.sessions.get(data.sessionId) : undefined;

    logger.info({ code: 'DAE-250', event: 'RESOLUTION_RECEIVED', mfe, capability, correlationId },
      'Registry resolved an MFE for the current state');

    try {
      // Step 1: Lookup the MFE's capability endpoints
      const registration = await this.lookupMfe(mfe);
      if (!registration) {
        this.publishResolutionError(data, correlationId, `unknown MFE "${mfe}"`);
        return;
      }

      // Client-side MFEs (module federation): the BaseMFE lifecycle runs in
      // the host shell's LayoutManager (ADR-055), not over HTTP. Synthesize
      // the RenderedExperience from the registration and relay immediately.
      if (registration.contentType === 'module-federation' &&
          registration.remoteEntryUrl && registration.moduleFederation) {
        const experience = {
          id: uuidv4(),
          mfe,
          capability,
          contentType: 'module-federation',
          output: {
            remoteEntryUrl: registration.remoteEntryUrl,
            scope: registration.moduleFederation.scope,
            module: registration.moduleFederation.module,
            component: registration.moduleFederation.component || capability,
            props: props || {}
          },
          props: props || {},
          createdAt: new Date().toISOString()
        };
        this.activeResolutions.set(sessionKey, { mfe, capability });
        const experienceComponent = {
          id: experience.id,
          type: EXPERIENCE_COMPONENT_TYPE,
          data: experience,
          createdAt: experience.createdAt
        };
        this.storeComponent(experienceComponent);
        this.publish(this.buildMessage({
          direction: MessageDirection.COMPONENT,
          kind: MessageKind.COMPONENT_UPDATE,
          payload: experienceComponent,
          metadata: { acknowledged: true, correlationId, error: null }
        }));
        logger.info({ code: 'DAE-253', event: 'EXPERIENCE_RELAYED', mfe, capability, expId: experience.id, clientSide: true },
          'Client-side MFE experience relayed to renderers');
        return;
      }

      // Step 2: Authorize with the session's JWT/user context
      const authorized = await this.invokeMfeAuthorize(registration, session, correlationId);
      if (!authorized) {
        this.publishResolutionError(data, correlationId, 'access denied');
        return;
      }

      // Step 4 (refresh branch): same MFE + capability already active → refresh
      const active = this.activeResolutions.get(sessionKey);
      if (active && active.mfe === mfe && active.capability === capability) {
        await this.invokeMfe(registration, '/refresh', session, correlationId,
          { full: false, capability, props: props || {} });
        logger.info({ code: 'DAE-252', event: 'MFE_REFRESHED', mfe, capability }, 'MFE refreshed in place');
        return;
      }

      // Step 3: Load once per MFE before its first render
      if (!this.loadedMfes.has(mfe)) {
        await this.invokeMfe(registration, '/load', session, correlationId, { config: {} });
        this.loadedMfes.add(mfe);
        logger.info({ code: 'DAE-251', event: 'MFE_LOADED', mfe }, 'MFE loaded');
      }

      // Step 4 (render branch): the MFE produces its own experience
      const body    = await this.invokeMfe(registration, '/render', session, correlationId,
        { capability, props: props || {} });
      const element = (body && body.element) || {};
      const experience = {
        id: (body && typeof body.id === 'string') ? body.id : uuidv4(),
        mfe,
        capability,
        output: ('output' in element) ? element.output : (body && body.element) || body,
        contentType: typeof element.contentType === 'string'
          ? element.contentType
          : registration.contentType || 'application/json',
        props: props || {},
        createdAt: new Date().toISOString()
      };

      // Step 5: Relay — store + broadcast as an EXPERIENCE component
      this.activeResolutions.set(sessionKey, { mfe, capability });
      const experienceComponent = {
        id: experience.id,
        type: EXPERIENCE_COMPONENT_TYPE,
        data: experience,
        createdAt: experience.createdAt
      };
      this.storeComponent(experienceComponent);
      this.publish(this.buildMessage({
        direction: MessageDirection.COMPONENT,
        kind: MessageKind.COMPONENT_UPDATE,
        payload: experienceComponent,
        metadata: { acknowledged: true, correlationId, error: null }
      }));
      logger.info({ code: 'DAE-253', event: 'EXPERIENCE_RELAYED', mfe, capability, expId: experience.id },
        'MFE experience relayed to renderers');
    } catch (err) {
      this.publishResolutionError(data, correlationId, err?.message || String(err));
    }
  }

  publishResolutionError(resolution, correlationId, reason) {
    logger.error({ code: 'DAE-299', event: 'RESOLUTION_FAILED', mfe: resolution.mfe, reason },
      'Resolution could not be fulfilled');
    this.publish(this.buildMessage({
      direction: MessageDirection.COMPONENT,
      kind: MessageKind.COMPONENT_UPDATE,
      payload: {
        id: correlationId,
        type: RESOLUTION_ERROR_COMPONENT_TYPE,
        data: { mfe: resolution.mfe, capability: resolution.capability, reason },
        createdAt: new Date().toISOString()
      },
      metadata: { acknowledged: false, correlationId, error: reason }
    }));
  }

  // ── MFE directory + HTTP capability invocation ──────────────────────────────

  registryHttpUrl() {
    return process.env.REGISTRY_HTTP_URL ||
      `http://${process.env.REGISTRY_HOST || 'registry'}:${process.env.REGISTRY_PORT || '4000'}`;
  }

  async lookupMfe(name) {
    if (this.mfeDirectory.has(name)) return this.mfeDirectory.get(name);
    try {
      const response = await fetch(`${this.registryHttpUrl()}/mfes`);
      if (response.ok) {
        const { mfes } = await response.json();
        for (const registration of mfes || []) this.mfeDirectory.set(registration.name, registration);
      }
    } catch (err) {
      logger.warn({ code: 'DAE-254', event: 'MFE_DIRECTORY_SYNC_FAILED', error: err?.message },
        'Could not sync MFE directory from registry');
    }
    return this.mfeDirectory.get(name) || null;
  }

  async invokeMfeAuthorize(registration, session, correlationId) {
    if (!Array.isArray(registration.capabilities) || !registration.capabilities.includes('authorizeAccess')) {
      return true; // MFEs that don't declare authorizeAccess are open
    }
    const body = await this.invokeMfe(registration, '/authorize', session, correlationId,
      { token: (session && session.jwt) || null, context: this.mfeContext(session, correlationId) });
    return body && body.authorized === true;
  }

  mfeContext(session, correlationId) {
    return {
      requestId:   correlationId,
      sessionId:   (session && session.sessionId) || null,
      user:        (session && session.user) || null,
      application: (session && session.application) || null,
      locale:      (session && session.locale) || null
    };
  }

  async invokeMfe(registration, path, session, correlationId, inputs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);
    try {
      const headers = { 'content-type': 'application/json' };
      if (session && session.jwt) headers.authorization = `Bearer ${session.jwt}`;
      const response = await fetch(`${registration.baseUrl.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ inputs, context: this.mfeContext(session, correlationId) }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`MFE ${registration.name}${path} responded ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
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
  enum MessageKind { COMPONENT_UPDATE STATE_SNAPSHOT ACTION_ECHO }

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
  }

  type Mutation {
    # Accepts a JSON-serialised message envelope (direction + payload).
    # Used by renderers to send user actions up to the daemon.
    sendMessage(message: String!): Boolean!
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
      componentStates: () => daemon.getComponentStates()
    },

    Mutation: {
      sendMessage: async (_, { message }) => {
        let parsed;
        try { parsed = JSON.parse(message); }
        catch { throw new Error('sendMessage: message must be a valid JSON string'); }
        await daemon.handleMessage(parsed);
        return true;
      }
    },

    Subscription: {
      messages: {
        subscribe: () => {
          const iteratorFactory = daemon.pubsub.asyncIterableIterator || daemon.pubsub.asyncIterator;
          if (!iteratorFactory) throw new Error('PubSub implementation does not expose an async iterator API');
          return iteratorFactory.call(daemon.pubsub, 'MESSAGES');
        }
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

module.exports = { startDaemon, ComponentDaemon };
