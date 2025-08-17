import React, { useState, useEffect, useCallback } from 'react';

// ========================
// REAL COMPONENT RENDERER
// React app that actually connects to daemon via GraphQL
// ========================

// ========================
// GRAPHQL WEBSOCKET CLIENT
// ========================

class GraphQLWebSocketClient {
  constructor(url = `ws://${window.location.hostname}:3001/graphql`) {
    this.url = url;
    this.ws = null;
    this.subscriptions = new Map();
    this.connected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.messageHandlers = new Map();
  }

  connect() {
    console.log(`🔌 Renderer: Attempting to connect to daemon at ${this.url}`);
    return new Promise((resolve, reject) => {
      try {
        // Modern graphql-transport-ws protocol
        this.ws = new WebSocket(this.url, 'graphql-transport-ws');
        this.ws.onopen = () => {
          console.log('✅ Renderer: WebSocket opened to daemon');
          this.connected = true;
          this.reconnectAttempts = 0;
          console.log('📡 Renderer: Sending connection_init to daemon');
          this.send({ type: 'connection_init' });
          resolve();
        };
        this.ws.onmessage = (event) => {
          let message; try { message = JSON.parse(event.data); } catch { return; }
          console.log('📨 Renderer: Message received from daemon:', message);
          this.handleMessage(message);
        };
        this.ws.onclose = (event) => {
          console.log('🔌 Renderer: WebSocket closed. Code:', event.code, 'Reason:', event.reason);
          this.connected = false;
          this.attemptReconnect();
        };
        this.ws.onerror = (error) => {
          console.error('❌ Renderer: WebSocket error:', error);
          console.error('❌ Renderer: WebSocket state:', this.ws.readyState);
          reject(error);
        };
      } catch (error) {
        console.error('❌ Renderer: Failed to create WebSocket:', error);
        reject(error);
      }
    });
  }

  send(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  handleMessage(message) {
    console.log('📨 Renderer: Raw message from daemon:', message);
    switch (message.type) {
      case 'connection_ack':
        console.log('📡 Renderer: Connection acknowledged');
        this.startSubscription();
        break;
      case 'next': { // graphql-transport-ws payload
        const container = message.payload?.data?.messages;
        if (container) {
          const handlers = this.messageHandlers.get(container.direction) || new Set();
          handlers.forEach(h => h(container));
        }
        break; }
      case 'error':
        console.error('❌ Renderer: GraphQL error:', message.payload);
        break;
      case 'complete':
        console.log('✅ Renderer: Operation completed', message.id);
        break;
      case 'ping':
        this.send({ type: 'pong' });
        break;
      default:
        console.log('📨 Renderer: Unknown message type:', message.type);
    }
  }

  startSubscription() {
    const subscriptionId = 'renderer-subscription';
    const subscription = {
      id: subscriptionId,
      type: 'subscribe', // modern protocol
      payload: {
        query: `\n          subscription {\n            messages {\n              direction\n              kind\n              payload\n              metadata { acknowledged correlationId error }\n            }\n          }\n        `
      }
    };
    this.send(subscription);
    console.log('📡 Renderer: Started subscription to daemon');
  }

  sendMessage(message) {
    const opId = `mutation-${Date.now()}`;
    const mutation = {
      id: opId,
      type: 'subscribe', // mutations/queries use subscribe frame
      payload: {
        query: `\n          mutation SendMessage($message: String!) {\n            sendMessage(message: $message)\n          }\n        `,
        variables: { message: JSON.stringify(message) }
      }
    };
    this.send(mutation);
  }

  onMessage(direction, callback) {
    if (!this.messageHandlers.has(direction)) {
      this.messageHandlers.set(direction, new Set());
    }
    this.messageHandlers.get(direction).add(callback);
    return () => {
      const handlers = this.messageHandlers.get(direction);
      if (handlers) handlers.delete(callback);
    };
  }

  subscribe(callback) {
    const subscriptionId = 'renderer-subscription';
    this.subscriptions.set(subscriptionId, { callback });
    return () => {
      this.subscriptions.delete(subscriptionId);
      if (this.connected) {
        this.send({ id: subscriptionId, type: 'complete' }); // terminate subscription
      }
    };
  }

  attemptReconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      console.log(`🔄 Renderer: Reconnecting... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
      setTimeout(() => { this.connect().catch(() => console.log('❌ Renderer: Reconnection failed')); }, 2000 * this.reconnectAttempts);
    } else {
      console.log('❌ Renderer: Max reconnection attempts reached');
    }
  }

  disconnect() {
    if (this.ws) this.ws.close();
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
    this.subscribers = new Set();
    this.messageHandlerCleanups = new Set();
    this.actions = [];
  }

  async connect() {
    try {
      // Register handlers BEFORE connect
      const componentHandler = this.graphqlClient.onMessage('COMPONENT', (message) => {
        this.handleComponentEnvelope(message);
      });
      const actionHandler = this.graphqlClient.onMessage('ACTION', (message) => {
        this.handleActionEnvelope(message);
      });
      this.messageHandlerCleanups.add(componentHandler);
      this.messageHandlerCleanups.add(actionHandler);

      await this.graphqlClient.connect();
      this.notify({ type: 'connected' });
    } catch (error) {
      console.error('❌ Renderer: Failed to connect to daemon:', error);
      this.notify({ type: 'connection_error', error });
    }
  }

  disconnect() {
    if (this.subscriptionCleanup) {
      this.subscriptionCleanup();
    }
    this.graphqlClient.disconnect();
    this.notify({ type: 'disconnected' });
  }

  handleComponentEnvelope(message) {
    const kind = message.kind;
    // STATE_SNAPSHOT carries { component, actions, lastUpdated }
    if (kind === 'STATE_SNAPSHOT' && message.payload?.component) {
      const snap = message.payload;
      const component = snap.component;
      if (!component?.id || !component?.type) return; // ignore malformed
      this.components.set(component.id, component);
      this.componentStates.set(component.id, {
        component,
        actions: snap.actions || [],
        lastUpdated: snap.lastUpdated || new Date().toISOString()
      });
      this.notify({ type: 'components_changed' });
      return;
    }
    // COMPONENT_UPDATE carries the component directly
    if (kind === 'COMPONENT_UPDATE') {
      const component = message.payload;
      if (!component?.id || !component?.type) return;
      this.components.set(component.id, component);
      if (!this.componentStates.has(component.id)) {
        this.componentStates.set(component.id, { component, actions: [], lastUpdated: new Date().toISOString() });
      } else {
        const st = this.componentStates.get(component.id);
        st.component = component;
        st.lastUpdated = new Date().toISOString();
      }
      this.notify({ type: 'components_changed' });
      return;
    }
    // Fallback: if payload looks like a component
    if (message.payload?.id && message.payload?.type) {
      const component = message.payload;
      this.components.set(component.id, component);
      if (!this.componentStates.has(component.id)) {
        this.componentStates.set(component.id, { component, actions: [], lastUpdated: new Date().toISOString() });
      }
      this.notify({ type: 'components_changed' });
    }
  }

  handleActionEnvelope(message) {
    if (message.kind === 'ACTION_ECHO') {
      this.actions.unshift(message.payload); // newest first
      this.actions = this.actions.slice(0, 50); // cap
      // Attach action to component state if exists
      const compId = message.payload?.componentId;
      if (compId && this.componentStates.has(compId)) {
        const st = this.componentStates.get(compId);
        st.actions.push(message.payload);
        st.lastUpdated = new Date().toISOString();
      }
      this.notify({ type: 'actions_changed' });
      this.notify({ type: 'components_changed' }); // to update counts
    }
  }

  sendAction(componentId, actionType, data) {
    const action = {
      id: `action-${Date.now()}`,
      componentId,
      actionType,
      data,
      timestamp: new Date().toISOString()
    };
    const message = {
      direction: 'ACTION',
      payload: action,
      metadata: { acknowledged: false, correlationId: action.id, error: null }
    };
    this.graphqlClient.sendMessage(message);
  }

  getRecentActions() { return this.actions; }

  subscribe(callback) {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  notify(event) {
    this.subscribers.forEach(callback => callback(event));
  }

  getComponents() {
    return Array.from(this.components.values());
  }
}

// ========================
// RULE EVALUATION BADGE
// ========================
const RuleEvaluation = ({ evalData }) => {
  if (!evalData) return null;
  const { rule, facts = {}, result } = evalData;
  const formatVal = (v) => {
    if (v == null) return 'null';
    if (Array.isArray(v)) return v.join(',');
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
      className="max-w-sm mx-auto bg-white rounded-lg shadow-md p-6 mb-4 cursor-pointer"
      onClick={() => onAction(componentId, 'CLICK', { timestamp: new Date().toISOString() })}
    >
      {data.title && (
        <h2 className="text-xl font-bold text-gray-900 mb-2">{data.title}</h2>
      )}
      {data.content && (
        <p className="text-gray-600">{data.content}</p>
      )}
      {data.buttons && (
        <div className="mt-4 space-x-2">
          {data.buttons.map((button, index) => (
            <button
              key={index}
              className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
              onClick={(e) => {
                e.stopPropagation();
                onAction(componentId, 'BUTTON_CLICK', { buttonIndex: index, ...button });
              }}
            >
              {button.text}
            </button>
          ))}
        </div>
      )}
      <RuleEvaluation evalData={data._ruleEvaluation} />
    </div>
  ),

  NOTIFICATION: ({ data }) => {
    const bgColor = {
      SUCCESS: 'bg-green-100 border-green-400 text-green-700',
      ERROR: 'bg-red-100 border-red-400 text-red-700',
      WARNING: 'bg-yellow-100 border-yellow-400 text-yellow-700',
      INFO: 'bg-blue-100 border-blue-400 text-blue-700'
    }[data.type] || 'bg-gray-100 border-gray-400 text-gray-700';

    return (
      <div className={`max-w-sm mx-auto border rounded p-4 mb-4 ${bgColor}`}>
        {data.title && <h3 className="font-bold mb-1">{data.title}</h3>}
        <p>{data.message}</p>
        <RuleEvaluation evalData={data._ruleEvaluation} />
      </div>
    );
  },

  FORM: ({ data, componentId, onAction }) => {
    const [formData, setFormData] = React.useState({});
    const handleSubmit = (e) => {
      e.preventDefault();
      onAction(componentId, 'SUBMIT', formData);
    };
    return (
      <form onSubmit={handleSubmit} className="max-w-sm mx-auto bg-white rounded-lg shadow-md p-6 mb-4">
        {data.title && (
          <h2 className="text-xl font-bold text-gray-900 mb-4">{data.title}</h2>
        )}
        <div className="space-y-4">
          {data.fields?.map((field, index) => (
            <div key={index}>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {field.label}
              </label>
              <input
                type={field.type?.toLowerCase() || 'text'}
                placeholder={field.placeholder}
                className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:border-blue-500"
                onChange={(e) => setFormData(prev => ({
                  ...prev,
                  [field.name || field.label]: e.target.value
                }))}
              />
            </div>
          ))}
        </div>
        <button
          type="submit"
          className="mt-4 w-full px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
        >
          {data.submitText || 'Submit'}
        </button>
        <RuleEvaluation evalData={data._ruleEvaluation} />
      </form>
    );
  }
};

// ========================
// REACT HOOKS
// ========================

const singletonDisplaySystem = new ComponentDisplaySystem();
const useComponentDisplay = () => {
  const [state, setState] = useState({
    components: [],
    connected: false,
    error: null,
    actions: []
  });

  const handleAction = useCallback((componentId, actionType, data) => {
    console.log('[Renderer] onAction called', { componentId, actionType, data });
    singletonDisplaySystem.sendAction(componentId, actionType, data);
  }, []);

  useEffect(() => {
    const unsubscribe = singletonDisplaySystem.subscribe((event) => {
      switch (event.type) {
        case 'actions_changed':
          setState(prev => ({ ...prev, actions: singletonDisplaySystem.getRecentActions() }));
          break;
        case 'connected':
          setState(prev => ({ ...prev, connected: true, error: null }));
          break;
        case 'disconnected':
          setState(prev => ({ ...prev, connected: false }));
          break;
        case 'connection_error':
          setState(prev => ({ 
            ...prev, 
            connected: false, 
            error: event.error?.message || 'Connection failed' 
          }));
          break;
        case 'components_changed':
          setState(prev => ({
            ...prev,
            components: singletonDisplaySystem.getComponents(),
            actions: singletonDisplaySystem.getRecentActions()
          }));
          break;
      }
    });

    // Connect to daemon
    singletonDisplaySystem.connect();

    // Cleanup on unmount
    return () => {
      unsubscribe();
      singletonDisplaySystem.disconnect();
    };
  }, []);

  return { ...state, onAction: handleAction };
};

// ========================
// MAIN APP
// ========================

export default function RealComponentRenderer() {
  const { components, connected, error, onAction, actions } = useComponentDisplay();

  const renderComponent = useCallback((component) => {
    const Renderer = UIRenderers[component.type];
    if (!Renderer) {
      console.warn(`No renderer found for component type: ${component.type}`);
      return null;
    }

    return (
      <div key={component.id} className="mb-4">
        <Renderer
          data={component.data}
          componentId={component.id}
          onAction={onAction}
        />
      </div>
    );
  }, [onAction]);

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-2xl mx-auto px-4">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">
            Interactive Component Renderer
          </h1>
          <div className="flex items-center justify-center space-x-2 mb-2">
            <div className={`w-3 h-3 rounded-full ${
              connected ? 'bg-green-500' : 
              error ? 'bg-red-500' : 'bg-yellow-500'
            }`}></div>
            <span className="text-sm text-gray-600">
              {connected ? 'Connected to Daemon' : 
               error ? `Error: ${error}` : 'Connecting...'}
            </span>
          </div>
          <p className="text-gray-600">
            Interactive Components: Registry ⇄ Daemon ⇄ <strong>Renderer</strong>
          </p>
        </div>

        {/* Connection Status */}
        <div className="bg-white rounded-lg shadow p-6 mb-8">
          <h3 className="font-bold mb-4">Real Connection Status</h3>
          <div className="text-sm space-y-3">
            <div className="flex items-center space-x-2">
              <div className="w-4 h-4 bg-blue-500 rounded flex items-center justify-center text-white text-xs">1</div>
              <span><strong>Component Registry</strong> (ws://localhost:4000/graphql)</span>
            </div>
            <div className="ml-4 text-gray-500">↓ Real GraphQL Subscription</div>
            <div className="flex items-center space-x-2">
              <div className="w-4 h-4 bg-green-500 rounded flex items-center justify-center text-white text-xs">2</div>
              <span><strong>Component Daemon</strong> (ws://localhost:3001/graphql)</span>
            </div>
            <div className="ml-4 text-gray-500">↓ Real GraphQL Subscription</div>
            <div className="flex items-center space-x-2">
              <div className={`w-4 h-4 rounded flex items-center justify-center text-white text-xs ${
                connected ? 'bg-purple-500' : 'bg-gray-400'
              }`}>3</div>
              <span><strong>Component Renderer</strong> (This React App) - {connected ? 'CONNECTED' : 'DISCONNECTED'}</span>
            </div>
          </div>
        </div>

        {/* Error Display */}
        {error && (
          <div className="bg-red-100 border border-red-400 rounded p-4 mb-6">
            <h3 className="font-bold text-red-700 mb-2">Connection Error</h3>
            <p className="text-red-600 text-sm">{error}</p>
            <p className="text-red-600 text-sm mt-2">
              Make sure the Component Daemon is running on port 3001
            </p>
          </div>
        )}

        {/* Components from Daemon */}
        <div className="space-y-4">
          <h3 className="text-lg font-semibold text-gray-900">Components from Daemon: ({components.length})</h3>
          {components.map(component => {
            const ComponentRenderer = UIRenderers[component.type];
            if (!ComponentRenderer) return null; // silently skip unknown now
            return (
              <div key={component.id} data-component-id={component.id}>
                <ComponentRenderer
                  data={component.data}
                  componentId={component.id}
                  onAction={onAction}
                />
              </div>
            );
          })}
        </div>
        {actions?.length > 0 && (
          <details className="mt-8 bg-white rounded p-4">
            <summary className="cursor-pointer font-medium">Recent Actions ({actions.length})</summary>
            <ul className="mt-3 space-y-2 text-xs font-mono">
              {actions.map(a => (
                <li key={a.id} className="border border-gray-200 rounded p-2 bg-gray-50">
                  <div className="flex justify-between"><span>{a.actionType}</span><span className="text-gray-400">{a.id}</span></div>
                  <pre className="mt-1 text-[10px] whitespace-pre-wrap">{JSON.stringify(a.data, null, 2)}</pre>
                </li>
              ))}
            </ul>
          </details>
        )}

        {/* Debug */}
        {components.length > 0 && (
          <details className="mt-8 bg-white rounded p-4">
            <summary className="cursor-pointer font-medium">
              Debug: {components.length} real components received
            </summary>
            <pre className="mt-2 text-xs bg-gray-100 p-3 rounded overflow-auto">
              {JSON.stringify(components, null, 2)}
            </pre>
          </details>
        )}

        {/* Test Instructions */}
        <div className="mt-8 bg-blue-50 border border-blue-200 rounded p-4">
          <h3 className="font-bold text-blue-800 mb-2">Test the Real Flow</h3>
          <p className="text-blue-700 text-sm mb-2">
            Send a real component through the system:
          </p>
          <pre className="bg-blue-100 p-2 rounded text-xs overflow-auto">
{`curl -X POST http://localhost:4000/render \\
  -H "Content-Type: application/json" \\
  -d '{
    "type": "CARD",
    "data": {
      "title": "Real Component!",
      "content": "This came from the real GraphQL flow!"
    }
  }'`}
          </pre>
        </div>
      </div>
    </div>
  );
}