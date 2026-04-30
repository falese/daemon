import React, { useState, useEffect, useCallback } from 'react';

// ========================
// COMPONENT RENDERER
// ========================
// Role in the system:
//   - Connects to the Daemon via GraphQL-WS subscription
//   - Receives component updates (COMPONENT_UPDATE, STATE_SNAPSHOT)
//   - Sends user actions back to the Daemon via GraphQL mutation
//   - Renders components dynamically based on their type

// ========================
// GRAPHQL WEBSOCKET CLIENT
// ========================
// Wraps the raw WebSocket and speaks the graphql-transport-ws protocol.
// Exposes two methods for callers:
//   onMessage(direction, callback) — receive COMPONENT or ACTION messages
//   sendMessage(envelope)          — send an action to the daemon

class GraphQLWebSocketClient {
  constructor() {
    // Port resolution order:
    //   1. ?daemonPort=N  query param  (hot-switch without rebuild)
    //   2. REACT_APP_DAEMON_PORT env var  (set in docker-compose or .env)
    //   3. 3001  (rust-daemon default)
    const qp = new URLSearchParams(window.location.search).get('daemonPort');
    const port = qp || process.env.REACT_APP_DAEMON_PORT || '3001';
    this.url = `ws://${window.location.hostname}:${port}/graphql`;
    this.ws = null;
    this.connected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.messageHandlers = new Map(); // direction -> Set<callback>
  }

  connect() {
    console.log(`🔌 Renderer: Connecting to daemon at ${this.url}`);
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url, 'graphql-transport-ws');

        this.ws.onopen = () => {
          console.log('✅ Renderer: WebSocket opened');
          this.connected = true;
          this.reconnectAttempts = 0;
          this.send({ type: 'connection_init' });
          resolve();
        };

        this.ws.onmessage = (event) => {
          let message;
          try {
            message = JSON.parse(event.data);
          } catch (e) {
            console.warn('[WS] Failed to parse message from daemon:', e.message);
            return;
          }
          this.handleProtocolMessage(message);
        };

        this.ws.onclose = (event) => {
          console.log('🔌 Renderer: WebSocket closed', event.code, event.reason);
          this.connected = false;
          this.attemptReconnect();
        };

        this.ws.onerror = (error) => {
          console.error('❌ Renderer: WebSocket error', error);
          reject(error);
        };
      } catch (error) {
        console.error('❌ Renderer: Failed to create WebSocket:', error);
        reject(error);
      }
    });
  }

  // Handle graphql-transport-ws protocol frames
  handleProtocolMessage(message) {
    switch (message.type) {
      case 'connection_ack':
        console.log('📡 Renderer: Connection acknowledged — starting subscription');
        this.startSubscription();
        break;

      case 'next': {
        // Subscription data arrives here; unwrap the GraphQL response envelope
        const envelope = message.payload?.data?.messages;
        if (envelope) {
          const handlers = this.messageHandlers.get(envelope.direction) || new Set();
          handlers.forEach(h => h(envelope));
        }
        break;
      }

      case 'error':
        console.error('❌ Renderer: GraphQL error from daemon:', message.payload);
        break;

      case 'ping':
        this.send({ type: 'pong' });
        break;

      case 'complete':
        console.log('✅ Renderer: Operation complete', message.id);
        break;

      default:
        // Other frames (e.g. pong) — no action needed
        break;
    }
  }

  // Subscribe to the daemon's `messages` subscription
  startSubscription() {
    this.send({
      id: 'renderer-sub',
      type: 'subscribe',
      payload: {
        query: `subscription {
          messages {
            direction
            kind
            payload
            metadata { acknowledged correlationId error }
          }
        }`
      }
    });
    console.log('📡 Renderer: Subscription started');
  }

  // Send an action to the daemon via a GraphQL mutation
  sendMessage(envelope) {
    this.send({
      id: `mutation-${Date.now()}`,
      type: 'subscribe', // graphql-transport-ws uses 'subscribe' frames for all operations
      payload: {
        query: `mutation SendMessage($message: String!) { sendMessage(message: $message) }`,
        variables: { message: JSON.stringify(envelope) }
      }
    });
  }

  // Register a callback for messages with a given direction (COMPONENT or ACTION)
  onMessage(direction, callback) {
    if (!this.messageHandlers.has(direction)) {
      this.messageHandlers.set(direction, new Set());
    }
    this.messageHandlers.get(direction).add(callback);
    return () => this.messageHandlers.get(direction)?.delete(callback); // returns cleanup fn
  }

  attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('❌ Renderer: Max reconnection attempts reached');
      return;
    }
    this.reconnectAttempts++;
    const delayMs = 2000 * this.reconnectAttempts;
    console.log(`🔄 Renderer: Reconnecting in ${delayMs}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
    setTimeout(() => this.connect().catch(() => {}), delayMs);
  }

  disconnect() {
    if (this.ws) this.ws.close();
  }

  send(message) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }
}

// ========================
// COMPONENT DISPLAY SYSTEM
// ========================
// Sits between the WS client and the React state.
// Maintains a local component store and notifies subscribers on changes.

class ComponentDisplaySystem {
  constructor() {
    this.graphqlClient = new GraphQLWebSocketClient();
    this.components = new Map();    // id -> component
    this.componentStates = new Map(); // id -> { component, actions, lastUpdated }
    this.slotMap = new Map();       // parentId -> Map<slotName, component>
    this.actions = [];              // recent action echoes (capped at 50)
    this.subscribers = new Set();   // React state update callbacks
  }

  async connect() {
    // Register message handlers before opening the socket so no messages are missed
    this.graphqlClient.onMessage('COMPONENT', msg => this.handleComponentEnvelope(msg));
    this.graphqlClient.onMessage('ACTION',    msg => this.handleActionEnvelope(msg));

    try {
      await this.graphqlClient.connect();
      this.notify({ type: 'connected' });
    } catch (error) {
      console.error('❌ Renderer: Connection to daemon failed:', error);
      this.notify({ type: 'connection_error', error });
    }
  }

  disconnect() {
    this.graphqlClient.disconnect();
    this.notify({ type: 'disconnected' });
  }

  // ── Component envelope handler ─────────────────────────────────────────────
  // Both STATE_SNAPSHOT and COMPONENT_UPDATE ultimately mean "upsert this
  // component into the local store". Extract the component then upsert.

  handleComponentEnvelope(message) {
    // SLOT_ASSIGNMENT: daemon tells us which component fills a named slot.
    // Update slotMap only — do not add the child to the top-level component list.
    if (message.kind === 'SLOT_ASSIGNMENT') {
      const { parentComponentId, slotName, childComponentId } = message.payload;
      if (!this.slotMap.has(parentComponentId))
        this.slotMap.set(parentComponentId, new Map());
      const child = childComponentId ? this.components.get(childComponentId) : null;
      this.slotMap.get(parentComponentId).set(slotName, child);
      this.notify({ type: 'components_changed' });
      return;
    }

    let component;

    if (message.kind === 'STATE_SNAPSHOT' && message.payload?.component) {
      // Snapshot carries { component, actions, lastUpdated }
      const snap = message.payload;
      component = snap.component;
      if (component?.id) {
        this.componentStates.set(component.id, {
          component,
          actions:     snap.actions || [],
          lastUpdated: snap.lastUpdated || new Date().toISOString()
        });
      }
    } else {
      // COMPONENT_UPDATE carries the component directly as payload
      component = message.payload;
    }

    if (!component?.id || !component?.type) return; // ignore malformed

    this.upsertComponent(component);
    this.notify({ type: 'components_changed' });
  }

  // Upsert a component into both the flat map and the state map
  upsertComponent(component) {
    this.components.set(component.id, component);
    const existing = this.componentStates.get(component.id);
    if (existing) {
      existing.component   = component;
      existing.lastUpdated = new Date().toISOString();
    } else {
      this.componentStates.set(component.id, {
        component,
        actions:     [],
        lastUpdated: new Date().toISOString()
      });
    }
  }

  // ── Action echo handler ────────────────────────────────────────────────────

  handleActionEnvelope(message) {
    if (message.kind !== 'ACTION_ECHO') return;
    const action = message.payload;

    // Track in local action history
    this.actions = [action, ...this.actions].slice(0, 50);

    // Attach to component state so the debug view can show it
    const state = this.componentStates.get(action?.componentId);
    if (state) {
      state.actions.push(action);
      state.lastUpdated = new Date().toISOString();
    }

    this.notify({ type: 'components_changed' });
  }

  // ── Action sending ─────────────────────────────────────────────────────────

  sendAction(componentId, actionType, data) {
    const action = {
      id:          `action-${Date.now()}`,
      componentId,
      actionType,
      data,
      timestamp:   new Date().toISOString()
    };
    this.graphqlClient.sendMessage({
      direction: 'ACTION',
      payload:   action,
      metadata:  { acknowledged: false, correlationId: action.id, error: null }
    });
  }

  // ── Pub/sub for React state updates ───────────────────────────────────────

  subscribe(callback) {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback); // returns cleanup fn
  }

  notify(event) {
    this.subscribers.forEach(cb => cb(event));
  }

  getComponents()     { return Array.from(this.components.values()); }
  getRecentActions()  { return this.actions; }

  // Returns a plain object { slotName: component | null } for a parent component.
  // The renderer calls this to pass resolved slots as props — it never queries them itself.
  getSlots(parentId) {
    const slots = this.slotMap.get(parentId);
    if (!slots) return {};
    return Object.fromEntries(slots);
  }
}

// Singleton — one connection shared across the whole app
const displaySystem = new ComponentDisplaySystem();

// ========================
// REACT HOOK
// ========================

const useComponentDisplay = () => {
  const [state, setState] = useState({
    components: [],
    connected:  false,
    error:      null,
    actions:    []
  });

  const onAction = useCallback((componentId, actionType, data) => {
    displaySystem.sendAction(componentId, actionType, data);
  }, []);

  useEffect(() => {
    const unsubscribe = displaySystem.subscribe((event) => {
      switch (event.type) {
        case 'connected':
          setState(prev => ({ ...prev, connected: true, error: null }));
          break;
        case 'disconnected':
          setState(prev => ({ ...prev, connected: false }));
          break;
        case 'connection_error':
          setState(prev => ({ ...prev, connected: false, error: event.error?.message || 'Connection failed' }));
          break;
        case 'components_changed':
          setState(prev => ({
            ...prev,
            components: displaySystem.getComponents(),
            actions:    displaySystem.getRecentActions()
          }));
          break;
        default:
          break;
      }
    });

    displaySystem.connect();

    return () => {
      unsubscribe();
      displaySystem.disconnect();
    };
  }, []);

  return { ...state, onAction };
};

// ========================
// RULE EVALUATION BADGE
// ========================
// Displayed on components that were generated by a rule to show which rule fired.

const RuleEvaluation = ({ evalData }) => {
  if (!evalData) return null;
  const { rule, facts = {}, result } = evalData;
  const formatVal = (v) => {
    if (v == null)          return 'null';
    if (Array.isArray(v))   return v.join(', ');
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  };
  return (
    <div className="mt-3 bg-blue-50 border border-blue-200 rounded p-2">
      <div className="flex items-center text-[10px] font-semibold tracking-wide text-blue-700 uppercase">
        <span className="px-1.5 py-0.5 bg-blue-600 text-white rounded mr-2">RULE</span>
        <span>{rule || 'unknown'}</span>
        {result && <span className="ml-auto text-blue-400">{result}</span>}
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        {Object.entries(facts).map(([k, v]) => (
          <span key={k} className="text-[10px] bg-white border border-blue-200 rounded-full px-2 py-0.5">
            {k}: {formatVal(v)}
          </span>
        ))}
      </div>
    </div>
  );
};

// ========================
// SLOT RENDERER
// ========================
// Renders whatever component the daemon has assigned to a slot.
// Receives the resolved component object (or null) — never queries for it.

const SlotRenderer = ({ component, onAction }) => {
  if (!component) {
    return (
      <div className="border border-dashed border-gray-300 rounded p-3 text-center text-gray-400 text-xs">
        Empty slot
      </div>
    );
  }
  // eslint-disable-next-line no-use-before-define
  const Renderer = UIRenderers[component.type];
  if (!Renderer) return null;
  return <Renderer data={component.data} componentId={component.id} onAction={onAction} slots={{}} />;
};

// ========================
// UI COMPONENT RENDERERS
// ========================
// One renderer per component type. Each receives `data`, `componentId`, `onAction`,
// and `slots` (a { [slotName]: component | null } object resolved by the daemon).
// Renderers declare which slots they render; they never decide what fills them.

const UIRenderers = {
  CARD: ({ data, componentId, onAction, slots = {} }) => (
    <div
      className="max-w-sm mx-auto bg-white rounded-lg shadow-md p-6 mb-4 cursor-pointer hover:shadow-lg transition-shadow"
      onClick={() => onAction(componentId, 'CLICK', { timestamp: new Date().toISOString() })}
    >
      {data.title   && <h2 className="text-xl font-bold text-gray-900 mb-2">{data.title}</h2>}
      {data.content && <p className="text-gray-600">{data.content}</p>}
      {data.buttons?.length > 0 && (
        <div className="mt-4 space-x-2">
          {data.buttons.map((button, i) => (
            <button
              key={i}
              className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
              onClick={(e) => { e.stopPropagation(); onAction(componentId, 'BUTTON_CLICK', { buttonIndex: i, ...button }); }}
            >
              {button.text}
            </button>
          ))}
        </div>
      )}
      {data.slots?.includes('detail') && (
        <div className="mt-4 border-t border-gray-100 pt-4">
          <p className="text-[10px] font-semibold tracking-wide text-gray-400 uppercase mb-2">Detail slot</p>
          <SlotRenderer component={slots.detail ?? null} onAction={onAction} />
        </div>
      )}
      <RuleEvaluation evalData={data._ruleEvaluation} />
    </div>
  ),

  NOTIFICATION: ({ data }) => {
    const styles = {
      SUCCESS: 'bg-green-100 border-green-400 text-green-700',
      ERROR:   'bg-red-100 border-red-400 text-red-700',
      WARNING: 'bg-yellow-100 border-yellow-400 text-yellow-700',
      INFO:    'bg-blue-100 border-blue-400 text-blue-700'
    };
    const colorClass = styles[data.status] || styles[data.type] || 'bg-gray-100 border-gray-400 text-gray-700';
    return (
      <div className={`max-w-sm mx-auto border rounded p-4 mb-4 ${colorClass}`}>
        {data.title && <h3 className="font-bold mb-1">{data.title}</h3>}
        <p>{data.message}</p>
        <RuleEvaluation evalData={data._ruleEvaluation} />
      </div>
    );
  },

  FORM: ({ data, componentId, onAction }) => {
    const [formData, setFormData] = React.useState({});
    return (
      <form
        onSubmit={(e) => { e.preventDefault(); onAction(componentId, 'SUBMIT', formData); }}
        className="max-w-sm mx-auto bg-white rounded-lg shadow-md p-6 mb-4"
      >
        {data.title && <h2 className="text-xl font-bold text-gray-900 mb-4">{data.title}</h2>}
        <div className="space-y-4">
          {data.fields?.map((field, i) => (
            <div key={i}>
              <label className="block text-sm font-medium text-gray-700 mb-1">{field.label}</label>
              <input
                type={field.type?.toLowerCase() || 'text'}
                placeholder={field.placeholder}
                className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:border-blue-500"
                onChange={(e) => setFormData(prev => ({ ...prev, [field.name || field.label]: e.target.value }))}
              />
            </div>
          ))}
        </div>
        <button type="submit" className="mt-4 w-full px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600">
          {data.submitText || 'Submit'}
        </button>
        <RuleEvaluation evalData={data._ruleEvaluation} />
      </form>
    );
  }
};

// ========================
// MAIN APP
// ========================

export default function App() {
  const { components, connected, error, onAction, actions } = useComponentDisplay();

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-2xl mx-auto px-4">

        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Control Plane Renderer</h1>
          <div className="flex items-center justify-center space-x-2 mb-2">
            <div className={`w-3 h-3 rounded-full ${connected ? 'bg-green-500' : error ? 'bg-red-500' : 'bg-yellow-500'}`} />
            <span className="text-sm text-gray-600">
              {connected ? 'Connected to Daemon' : error ? `Error: ${error}` : 'Connecting…'}
            </span>
          </div>
          <p className="text-gray-500 text-sm">Registry → Daemon → <strong>Renderer</strong></p>
        </div>

        {/* Architecture legend */}
        <div className="bg-white rounded-lg shadow p-4 mb-6 text-sm space-y-2">
          <div className="flex items-center space-x-2">
            <span className="w-5 h-5 bg-blue-500 text-white rounded text-xs flex items-center justify-center">1</span>
            <span><strong>Registry</strong> — rules engine, publishes components (port 4000)</span>
          </div>
          <div className="ml-4 text-gray-400 text-xs">↓ GraphQL subscription</div>
          <div className="flex items-center space-x-2">
            <span className="w-5 h-5 bg-green-500 text-white rounded text-xs flex items-center justify-center">2</span>
            <span><strong>Daemon</strong> — routes components down, actions up (port 3001)</span>
          </div>
          <div className="ml-4 text-gray-400 text-xs">↓ GraphQL subscription</div>
          <div className="flex items-center space-x-2">
            <span className={`w-5 h-5 text-white rounded text-xs flex items-center justify-center ${connected ? 'bg-purple-500' : 'bg-gray-400'}`}>3</span>
            <span><strong>Renderer</strong> — this app ({connected ? 'connected' : 'disconnected'})</span>
          </div>
        </div>

        {/* Connection error */}
        {error && (
          <div className="bg-red-100 border border-red-400 rounded p-4 mb-6">
            <p className="font-bold text-red-700">Connection Error</p>
            <p className="text-red-600 text-sm">{error}</p>
            <p className="text-red-500 text-xs mt-1">Is the daemon running on port 3001?</p>
          </div>
        )}

        {/* Live components */}
        <h3 className="text-lg font-semibold text-gray-900 mb-3">
          Live Components ({components.length})
        </h3>

        {components.length === 0 && connected && (
          <p className="text-gray-400 text-sm mb-4">
            No components yet. Run <code className="bg-gray-100 px-1 rounded">make form</code> to inject one.
          </p>
        )}

        {components.map(component => {
          const Renderer = UIRenderers[component.type];
          if (!Renderer) return null;
          const slots = displaySystem.getSlots(component.id);
          // Hide components that are assigned to a parent slot — they render inside their parent
          const isSlotted = Array.from(displaySystem.slotMap.values()).some(
            m => Array.from(m.values()).some(c => c?.id === component.id)
          );
          if (isSlotted) return null;
          return (
            <div key={component.id}>
              <Renderer data={component.data} componentId={component.id} onAction={onAction} slots={slots} />
            </div>
          );
        })}

        {/* Recent actions (collapsed by default) */}
        {actions.length > 0 && (
          <details className="mt-6 bg-white rounded p-4 shadow-sm">
            <summary className="cursor-pointer font-medium text-sm">Recent Actions ({actions.length})</summary>
            <ul className="mt-3 space-y-2 text-xs font-mono">
              {actions.map(a => (
                <li key={a.id} className="border border-gray-200 rounded p-2 bg-gray-50">
                  <div className="flex justify-between">
                    <span className="font-semibold">{a.actionType}</span>
                    <span className="text-gray-400">{a.id}</span>
                  </div>
                  <pre className="mt-1 text-[10px] whitespace-pre-wrap text-gray-600">
                    {JSON.stringify(a.data, null, 2)}
                  </pre>
                </li>
              ))}
            </ul>
          </details>
        )}

        {/* Raw component data (collapsed by default) */}
        {components.length > 0 && (
          <details className="mt-3 bg-white rounded p-4 shadow-sm">
            <summary className="cursor-pointer font-medium text-sm">Raw Component Data</summary>
            <pre className="mt-2 text-xs bg-gray-100 p-3 rounded overflow-auto">
              {JSON.stringify(components, null, 2)}
            </pre>
          </details>
        )}

      </div>
    </div>
  );
}
