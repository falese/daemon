import React, { useState, useEffect, useCallback, useRef } from 'react';

// ========================
// GRAPHQL WEBSOCKET CLIENT
// ========================
// Wraps the raw WebSocket and speaks the graphql-transport-ws protocol.
// Exposes two methods for callers:
//   onMessage(direction, callback) — receive COMPONENT or ACTION messages
//   sendMessage(envelope)          — send an action to the daemon

class GraphQLWebSocketClient {
  constructor(url = `ws://${window.location.hostname}:3001/graphql`) {
    this.url = url;
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
    return () => this.messageHandlers.get(direction)?.delete(callback);
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

class ComponentDisplaySystem {
  constructor() {
    this.graphqlClient = new GraphQLWebSocketClient();
    this.components = new Map();
    this.componentStates = new Map();
    this.actions = [];
    this.subscribers = new Set();
  }

  async connect() {
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

  handleComponentEnvelope(message) {
    let component;
    if (message.kind === 'STATE_SNAPSHOT' && message.payload?.component) {
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
      component = message.payload;
    }
    if (!component?.id || !component?.type) return;
    this.upsertComponent(component);
    this.notify({ type: 'components_changed' });
  }

  upsertComponent(component) {
    this.components.set(component.id, component);
    const existing = this.componentStates.get(component.id);
    if (existing) {
      existing.component   = component;
      existing.lastUpdated = new Date().toISOString();
    } else {
      this.componentStates.set(component.id, {
        component, actions: [], lastUpdated: new Date().toISOString()
      });
    }
  }

  handleActionEnvelope(message) {
    if (message.kind !== 'ACTION_ECHO') return;
    const action = message.payload;
    this.actions = [action, ...this.actions].slice(0, 50);
    const state = this.componentStates.get(action?.componentId);
    if (state) { state.actions.push(action); state.lastUpdated = new Date().toISOString(); }
    this.notify({ type: 'components_changed' });
  }

  sendAction(componentId, actionType, data) {
    const action = { id: `action-${Date.now()}`, componentId, actionType, data, timestamp: new Date().toISOString() };
    this.graphqlClient.sendMessage({
      direction: 'ACTION', payload: action,
      metadata: { acknowledged: false, correlationId: action.id, error: null }
    });
  }

  subscribe(callback) {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  notify(event) { this.subscribers.forEach(cb => cb(event)); }
  getComponents()    { return Array.from(this.components.values()); }
  getRecentActions() { return this.actions; }
}

const displaySystem = new ComponentDisplaySystem();

// ========================
// REGISTRY HOOK
// ========================

const useComponentDisplay = () => {
  const [state, setState] = useState({ components: [], connected: false, error: null, actions: [] });
  const onAction = useCallback((componentId, actionType, data) => {
    displaySystem.sendAction(componentId, actionType, data);
  }, []);

  useEffect(() => {
    const unsubscribe = displaySystem.subscribe((event) => {
      switch (event.type) {
        case 'connected':
          setState(prev => ({ ...prev, connected: true, error: null })); break;
        case 'disconnected':
          setState(prev => ({ ...prev, connected: false })); break;
        case 'connection_error':
          setState(prev => ({ ...prev, connected: false, error: event.error?.message || 'Connection failed' })); break;
        case 'components_changed':
          setState(prev => ({ ...prev, components: displaySystem.getComponents(), actions: displaySystem.getRecentActions() })); break;
      }
    });
    displaySystem.connect();
    return () => { unsubscribe(); displaySystem.disconnect(); };
  }, []);

  return { ...state, onAction };
};

// ========================
// GRAPH SERVICE — HTTP + WS
// ========================

const GRAPH_HTTP = `http://${window.location.hostname}:4100/graphql`;
const GRAPH_WS   = `ws://${window.location.hostname}:4100/graphql`;

async function graphQL(query, variables = {}) {
  const res = await fetch(GRAPH_HTTP, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors.map(e => e.message).join('\n'));
  return json.data;
}

// Build the demo checkout state machine in the graph service
async function setupDemoMachine() {
  const { createStateObject: state } = await graphQL(
    `mutation { createStateObject(type: "checkout", data: {}) { id availableTransitions { actionType } } }`
  );

  const [cart, addr, confirm] = await Promise.all([
    graphQL(`mutation { createExperience(name: "Cart")    { id } }`).then(d => d.createExperience),
    graphQL(`mutation { createExperience(name: "Address") { id } }`).then(d => d.createExperience),
    graphQL(`mutation { createExperience(name: "Confirm") { id } }`).then(d => d.createExperience),
  ]);

  // Populate each experience with a layout + component
  for (const [exp, compData] of [
    [cart, { type: 'CARD', data: { title: 'Your Cart 🛒', content: 'Review items before checkout.', buttons: [{ text: 'Continue →' }] } }],
    [addr, { type: 'FORM', data: { title: 'Shipping Address 📦', fields: [{ name: 'name', label: 'Full Name', type: 'text' }, { name: 'address', label: 'Street Address', type: 'text' }, { name: 'city', label: 'City', type: 'text' }], submitText: 'Continue →' } }],
    [confirm, { type: 'NOTIFICATION', data: { status: 'SUCCESS', title: 'Order Confirmed! ✅', message: 'Thanks for your order. A confirmation email is on its way.' } }],
  ]) {
    const layout = await graphQL(
      `mutation($e:ID!) { createLayout(type:"PAGE", experienceId:$e) { id } }`,
      { e: exp.id }
    ).then(d => d.createLayout);
    await graphQL(
      `mutation($t:String!, $d:JSON, $p:ID!) { createComponent(type:$t, data:$d, parentLayoutId:$p) { id } }`,
      { t: compData.type, d: compData.data, p: layout.id }
    );
  }

  // Wire transitions: STATE→Cart, Cart→Address, Address→Confirm
  await graphQL(
    `mutation($s:ID!,$t:ID!) { addTransition(sourceNodeId:$s, sourceKind:STATE_OBJECT, actionType:"START", targetExperienceId:$t) { id } }`,
    { s: state.id, t: cart.id }
  );
  await graphQL(
    `mutation($s:ID!,$t:ID!) { addTransition(sourceNodeId:$s, sourceKind:EXPERIENCE, actionType:"NEXT", targetExperienceId:$t) { id } }`,
    { s: cart.id, t: addr.id }
  );
  await graphQL(
    `mutation($s:ID!,$t:ID!) { addTransition(sourceNodeId:$s, sourceKind:EXPERIENCE, actionType:"NEXT", targetExperienceId:$t) { id } }`,
    { s: addr.id, t: confirm.id }
  );

  return state.id;
}

// GraphQL subscription client for the graph service
class GraphSubscriptionClient {
  constructor(stateId, onEvent) {
    this.stateId = stateId;
    this.onEvent = onEvent;
    this.ws = null;
  }

  connect() {
    this.ws = new WebSocket(GRAPH_WS, 'graphql-transport-ws');
    this.ws.onopen = () => this.ws.send(JSON.stringify({ type: 'connection_init' }));
    this.ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.type === 'connection_ack') {
        this.ws.send(JSON.stringify({
          id: 'graph-sub', type: 'subscribe',
          payload: {
            query: `subscription($sid:ID!) {
              experienceUpdated(stateId:$sid) {
                stateId actionType terminal
                experience {
                  name
                  layouts { id type children {
                    __typename
                    ... on Layout   { id type children { __typename ... on Component { id type data } } }
                    ... on Component { id type data }
                  }}
                }
              }
            }`,
            variables: { sid: this.stateId }
          }
        }));
      } else if (msg.type === 'next') {
        const event = msg.payload?.data?.experienceUpdated;
        if (event) this.onEvent(event);
      } else if (msg.type === 'ping') {
        this.ws.send(JSON.stringify({ type: 'pong' }));
      }
    };
    this.ws.onerror = (e) => console.error('❌ Graph WS error:', e);
  }

  disconnect() { this.ws?.close(); }
}

// ========================
// GRAPH STATE HOOK
// ========================

const useGraphState = () => {
  const [gs, setGs] = useState({
    status: 'idle',    // idle | setting-up | ready | error
    stateId: null,
    experience: null,
    availableTransitions: [],
    terminal: false,
    log: []
  });
  const wsRef = useRef(null);

  const addLog = (msg) => setGs(prev => ({
    ...prev,
    log: [`${new Date().toLocaleTimeString()} ${msg}`, ...prev.log].slice(0, 20)
  }));

  const setupDemo = async () => {
    setGs(prev => ({ ...prev, status: 'setting-up', log: [] }));
    try {
      addLog('Building demo checkout machine…');
      const stateId = await setupDemoMachine();
      addLog(`StateObject: ${stateId.slice(0, 8)}…`);

      if (wsRef.current) wsRef.current.disconnect();
      wsRef.current = new GraphSubscriptionClient(stateId, (event) => {
        setGs(prev => ({
          ...prev,
          experience: event.experience,
          terminal: event.terminal,
          log: [`${new Date().toLocaleTimeString()} → ${event.experience?.name} via ${event.actionType}`, ...prev.log].slice(0, 20)
        }));
      });
      wsRef.current.connect();

      const init = await graphQL(
        `query($id:ID!) { stateObject(id:$id) { availableTransitions { actionType } isTerminal } }`,
        { id: stateId }
      );
      setGs(prev => ({
        ...prev,
        status: 'ready', stateId,
        availableTransitions: init.stateObject.availableTransitions.map(t => t.actionType),
        terminal: init.stateObject.isTerminal,
        log: [`${new Date().toLocaleTimeString()} Ready — fire START to begin`, ...prev.log]
      }));
    } catch (err) {
      setGs(prev => ({ ...prev, status: 'error', log: [`Error: ${err.message}`] }));
    }
  };

  const fireAction = async (actionType, actionData = {}) => {
    if (!gs.stateId) return;
    try {
      const result = await graphQL(
        `mutation($id:ID!,$a:ActionInput!) {
           mutateState(id:$id, action:$a) {
             transitioned terminal
             experience { name layouts { id type children {
               __typename
               ... on Layout   { id type children { __typename ... on Component { id type data } } }
               ... on Component { id type data }
             }}}
             state { availableTransitions { actionType } isTerminal }
           }
         }`,
        { id: gs.stateId, a: { type: actionType, data: actionData } }
      ).then(d => d.mutateState);

      setGs(prev => ({
        ...prev,
        experience: result.experience || prev.experience,
        terminal: result.terminal,
        availableTransitions: result.state.availableTransitions.map(t => t.actionType),
        log: result.transitioned
          ? prev.log
          : [`${new Date().toLocaleTimeString()} ↩ ${actionType} — no matching transition`, ...prev.log].slice(0, 20)
      }));
    } catch (err) {
      addLog(`Error: ${err.message}`);
    }
  };

  const resetMachine = async () => {
    if (!gs.stateId) return;
    const result = await graphQL(
      `mutation($id:ID!) { resetState(id:$id) { availableTransitions { actionType } isTerminal } }`,
      { id: gs.stateId }
    ).then(d => d.resetState);
    setGs(prev => ({
      ...prev,
      experience: null, terminal: result.isTerminal,
      availableTransitions: result.availableTransitions.map(t => t.actionType),
      log: [`${new Date().toLocaleTimeString()} ↺ Reset`, ...prev.log].slice(0, 20)
    }));
  };

  useEffect(() => () => wsRef.current?.disconnect(), []);

  return { gs, setupDemo, fireAction, resetMachine };
};

// ========================
// RULE EVALUATION BADGE
// ========================

const RuleEvaluation = ({ evalData }) => {
  if (!evalData) return null;
  const { rule, facts = {}, result } = evalData;
  const formatVal = (v) => {
    if (v == null)            return 'null';
    if (Array.isArray(v))     return v.join(', ');
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
// UI COMPONENT RENDERERS
// ========================

const UIRenderers = {
  CARD: ({ data, componentId, onAction }) => (
    <div
      className="bg-white rounded-lg shadow-md p-5 mb-3 cursor-pointer hover:shadow-lg transition-shadow"
      onClick={() => onAction(componentId, 'CLICK', { timestamp: new Date().toISOString() })}
    >
      {data.title   && <h2 className="text-lg font-bold text-gray-900 mb-1">{data.title}</h2>}
      {data.content && <p className="text-gray-600 text-sm">{data.content}</p>}
      {data.buttons?.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {data.buttons.map((btn, i) => (
            <button
              key={i}
              className="px-3 py-1.5 bg-blue-500 text-white text-sm rounded hover:bg-blue-600"
              onClick={(e) => { e.stopPropagation(); onAction(componentId, 'BUTTON_CLICK', { buttonIndex: i, ...btn }); }}
            >
              {btn.text}
            </button>
          ))}
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
      <div className={`border rounded p-4 mb-3 ${colorClass}`}>
        {data.title && <h3 className="font-bold mb-1">{data.title}</h3>}
        <p className="text-sm">{data.message}</p>
        <RuleEvaluation evalData={data._ruleEvaluation} />
      </div>
    );
  },

  FORM: ({ data, componentId, onAction }) => {
    const [formData, setFormData] = React.useState({});
    return (
      <form
        onSubmit={(e) => { e.preventDefault(); onAction(componentId, 'SUBMIT', formData); }}
        className="bg-white rounded-lg shadow-md p-5 mb-3"
      >
        {data.title && <h2 className="text-lg font-bold text-gray-900 mb-3">{data.title}</h2>}
        <div className="space-y-3">
          {data.fields?.map((field, i) => (
            <div key={i}>
              <label className="block text-sm font-medium text-gray-700 mb-1">{field.label}</label>
              <input
                type={field.type?.toLowerCase() || 'text'}
                placeholder={field.placeholder}
                className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:border-blue-500 text-sm"
                onChange={(e) => setFormData(prev => ({ ...prev, [field.name || field.label]: e.target.value }))}
              />
            </div>
          ))}
        </div>
        <button type="submit" className="mt-4 w-full px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 text-sm">
          {data.submitText || 'Submit'}
        </button>
        <RuleEvaluation evalData={data._ruleEvaluation} />
      </form>
    );
  }
};

// ========================
// EXPERIENCE RENDERER
// ========================
// Recursively renders a Layout/Component tree from the graph service.
// Components that match existing UIRenderers are rendered with full interactivity.

function renderGraphChild(child, fireAction, depth = 0) {
  if (!child) return null;

  if (child.__typename === 'Layout') {
    return (
      <div
        key={child.id}
        className={`border border-dashed border-indigo-200 rounded-lg p-3 mb-2 ${depth > 0 ? 'ml-3' : ''}`}
      >
        <div className="text-[10px] text-indigo-400 uppercase tracking-widest mb-2">
          {child.type}
        </div>
        {(child.children || []).map(c => renderGraphChild(c, fireAction, depth + 1))}
      </div>
    );
  }

  // Component node — use a UIRenderer if one exists for the type
  const Renderer = UIRenderers[child.type];
  if (Renderer) {
    return (
      <Renderer
        key={child.id}
        data={child.data || {}}
        componentId={child.id}
        onAction={(_cId, actionType, actionData) => fireAction(actionType, actionData)}
      />
    );
  }

  // Fallback for unknown component types
  return (
    <div key={child.id} className="bg-gray-50 border border-gray-200 rounded p-3 mb-2 text-sm font-mono">
      <div className="font-semibold text-gray-600">{child.type}</div>
      <pre className="text-xs text-gray-400 mt-1 whitespace-pre-wrap">{JSON.stringify(child.data, null, 2)}</pre>
    </div>
  );
}

// ========================
// GRAPH PANEL
// ========================

function GraphPanel() {
  const { gs, setupDemo, fireAction, resetMachine } = useGraphState();
  const { status, experience, availableTransitions, terminal, log } = gs;

  return (
    <div className="bg-white rounded-lg shadow p-5 h-full flex flex-col">
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div>
          <h2 className="text-base font-bold text-gray-900">Experience Graph</h2>
          <p className="text-xs text-indigo-500 mt-0.5">graph service · :4100</p>
        </div>
        <div className="flex gap-2 flex-shrink-0 ml-2">
          {status === 'ready' && (
            <button
              onClick={resetMachine}
              className="px-2.5 py-1 text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 rounded"
            >
              ↺ Reset
            </button>
          )}
          <button
            onClick={setupDemo}
            disabled={status === 'setting-up'}
            className="px-3 py-1 text-xs bg-indigo-600 hover:bg-indigo-700 text-white rounded disabled:opacity-50"
          >
            {status === 'setting-up' ? 'Building…' : status === 'ready' ? '+ New' : 'Setup Demo'}
          </button>
        </div>
      </div>

      {/* Idle */}
      {status === 'idle' && (
        <p className="text-sm text-gray-400 text-center py-12 flex-1">
          Click <strong>Setup Demo</strong> to build a checkout state machine and connect to it.
        </p>
      )}

      {/* Error */}
      {status === 'error' && (
        <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700 mb-4">
          Graph service unreachable. Is it running?<br />
          <code className="text-xs">docker compose up graph mongo</code>
        </div>
      )}

      {status === 'ready' && (
        <div className="flex flex-col flex-1 min-h-0">
          {/* Experience canvas */}
          <div className="flex-1 min-h-[160px] border border-gray-100 rounded-lg p-4 mb-4 bg-indigo-50/30 overflow-y-auto">
            {experience ? (
              <>
                <div className="text-xs font-semibold text-indigo-600 uppercase tracking-wide mb-3">
                  {experience.name}
                </div>
                {(experience.layouts || []).map(layout => (
                  <div key={layout.id}>
                    {(layout.children || []).map(child => renderGraphChild(child, fireAction))}
                  </div>
                ))}
              </>
            ) : (
              <p className="text-sm text-gray-400 text-center pt-10">
                Fire <strong>START</strong> to enter the first experience.
              </p>
            )}
          </div>

          {/* Available transitions */}
          <div className="mb-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Actions</span>
              {terminal && (
                <span className="text-[10px] px-2 py-0.5 bg-amber-100 text-amber-700 rounded-full">
                  Terminal
                </span>
              )}
            </div>
            {availableTransitions.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {availableTransitions.map(action => (
                  <button
                    key={action}
                    onClick={() => fireAction(action)}
                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 active:scale-95 text-white text-sm rounded-lg font-medium transition-all"
                  >
                    {action}
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-sm text-gray-400">
                {terminal ? 'Machine terminated — reset to replay.' : 'No transitions available.'}
              </p>
            )}
          </div>

          {/* Transition log */}
          {log.length > 0 && (
            <details open className="text-xs border-t border-gray-100 pt-3">
              <summary className="cursor-pointer text-gray-400 mb-1 select-none">Transition log</summary>
              <ul className="mt-1 space-y-0.5 font-mono max-h-28 overflow-y-auto">
                {log.map((entry, i) => (
                  <li key={i} className="text-gray-400">{entry}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

// ========================
// REGISTRY PANEL
// ========================

function RegistryPanel({ components, connected, error, onAction, actions }) {
  return (
    <div className="bg-white rounded-lg shadow p-5">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-bold text-gray-900">Registry Components</h2>
          <p className="text-xs text-gray-500 mt-0.5">daemon · :3001 → registry · :4000</p>
        </div>
        <div className="flex items-center gap-1.5">
          <div className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : error ? 'bg-red-500' : 'bg-yellow-400'}`} />
          <span className="text-xs text-gray-500">
            {connected ? 'Connected' : error ? 'Error' : 'Connecting…'}
          </span>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded p-3 mb-4 text-sm text-red-700">
          {error} — is the daemon running on port 3001?
        </div>
      )}

      <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-3">
        Live Components ({components.length})
      </div>

      {components.length === 0 && connected && (
        <p className="text-sm text-gray-400 mb-4">
          No components yet. Run <code className="bg-gray-100 px-1 rounded text-xs">make form</code> to inject one.
        </p>
      )}

      {components.map(component => {
        const Renderer = UIRenderers[component.type];
        if (!Renderer) return null;
        return <Renderer key={component.id} data={component.data} componentId={component.id} onAction={onAction} />;
      })}

      {actions.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-xs text-gray-400 select-none">
            Recent Actions ({actions.length})
          </summary>
          <ul className="mt-2 space-y-1.5 text-xs font-mono max-h-40 overflow-y-auto">
            {actions.map(a => (
              <li key={a.id} className="border border-gray-100 rounded p-2 bg-gray-50">
                <div className="flex justify-between">
                  <span className="font-semibold">{a.actionType}</span>
                  <span className="text-gray-400">{a.id}</span>
                </div>
                <pre className="mt-0.5 text-[10px] whitespace-pre-wrap text-gray-500">
                  {JSON.stringify(a.data, null, 2)}
                </pre>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

// ========================
// MAIN APP
// ========================

export default function App() {
  const { components, connected, error, onAction, actions } = useComponentDisplay();

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      {/* Header */}
      <div className="max-w-6xl mx-auto mb-6 text-center">
        <h1 className="text-2xl font-bold text-gray-900">Control Plane Renderer</h1>
        <p className="text-sm text-gray-500 mt-1">
          Registry rules engine &nbsp;·&nbsp; Daemon middleware &nbsp;·&nbsp; Experience graph state machine
        </p>
      </div>

      {/* Two-column layout */}
      <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        <RegistryPanel
          components={components}
          connected={connected}
          error={error}
          onAction={onAction}
          actions={actions}
        />
        <GraphPanel />
      </div>
    </div>
  );
}
