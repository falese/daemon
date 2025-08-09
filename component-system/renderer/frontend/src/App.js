import React, { useState, useEffect } from 'react';

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
  }

  connect() {
    console.log(`🔌 Renderer: Attempting to connect to daemon at ${this.url}`);
    
    return new Promise((resolve, reject) => {
      try {
        // Create WebSocket connection for GraphQL subscriptions
        this.ws = new WebSocket(this.url, 'graphql-ws');
        
        this.ws.onopen = () => {
          console.log('✅ Renderer: WebSocket opened to daemon');
          this.connected = true;
          this.reconnectAttempts = 0;
          
          // Send connection init for graphql-ws protocol
          console.log('📡 Renderer: Sending connection_init to daemon');
          this.send({
            type: 'connection_init'
          });
          
          resolve();
        };

        this.ws.onmessage = (event) => {
          const message = JSON.parse(event.data);
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
        // Start subscription after connection is acknowledged
        this.startSubscription();
        break;
        
      case 'data':
        console.log('📨 Renderer: Data message received:', message);
        // Handle subscription data
        const subscription = this.subscriptions.get(message.id);
        if (subscription && message.payload?.data?.rendererUpdate) {
          console.log('📦 Renderer: Found rendererUpdate in payload');
          subscription.callback(message.payload.data.rendererUpdate);
        } else {
          console.log('❓ Renderer: No rendererUpdate found in payload:', message.payload);
        }
        break;
        
      case 'error':
        console.error('❌ Renderer: GraphQL error:', message.payload);
        break;
        
      case 'complete':
        console.log('✅ Renderer: Subscription completed');
        break;
        
      default:
        console.log('📨 Renderer: Unknown message type:', message.type);
    }
  }

  startSubscription() {
    const subscriptionId = 'renderer-subscription';
    
    // GraphQL subscription query
    const subscription = {
      id: subscriptionId,
      type: 'start',
      payload: {
        query: `
          subscription {
            rendererUpdate {
              id
              type
              data
              createdAt
            }
          }
        `
      }
    };

    this.send(subscription);
    console.log('📡 Renderer: Started subscription to daemon');
  }

  subscribe(callback) {
    const subscriptionId = 'renderer-subscription';
    this.subscriptions.set(subscriptionId, { callback });
    
    return () => {
      this.subscriptions.delete(subscriptionId);
      if (this.connected) {
        this.send({
          id: subscriptionId,
          type: 'stop'
        });
      }
    };
  }

  attemptReconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      console.log(`🔄 Renderer: Reconnecting... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
      
      setTimeout(() => {
        this.connect().catch(() => {
          console.log('❌ Renderer: Reconnection failed');
        });
      }, 2000 * this.reconnectAttempts);
    } else {
      console.log('❌ Renderer: Max reconnection attempts reached');
    }
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
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
    this.subscribers = new Set();
    this.subscriptionCleanup = null;
  }

  async connect() {
    try {
      await this.graphqlClient.connect();
      
      // Subscribe to daemon updates
      this.subscriptionCleanup = this.graphqlClient.subscribe((component) => {
        this.handleComponentFromDaemon(component);
      });

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

  handleComponentFromDaemon(component) {
    console.log(`📦 Renderer: Received component from daemon:`, component);
    
    this.components.set(component.id, component);
    this.notify({ type: 'components_changed' });

    // Handle auto-removal if specified
    if (component.data?.autoRemove) {
      setTimeout(() => {
        this.removeComponent(component.id);
      }, component.data.autoRemove);
    }
  }

  removeComponent(componentId) {
    this.components.delete(componentId);
    this.notify({ type: 'components_changed' });
  }

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
// UI COMPONENT RENDERERS
// ========================

const UIRenderers = {
  CARD: ({ data }) => (
    <div className="max-w-sm mx-auto bg-white rounded-lg shadow-md p-6 mb-4">
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
            >
              {button.text}
            </button>
          ))}
        </div>
      )}
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
      </div>
    );
  },

  FORM: ({ data }) => (
    <div className="max-w-sm mx-auto bg-white rounded-lg shadow-md p-6 mb-4">
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
            />
          </div>
        ))}
        <button className="w-full px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600">
          {data.submitText || 'Submit'}
        </button>
      </div>
    </div>
  )
};

// ========================
// REACT HOOKS
// ========================

const useComponentDisplay = () => {
  const [displaySystem] = useState(() => new ComponentDisplaySystem());
  const [components, setComponents] = useState([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const unsubscribe = displaySystem.subscribe((event) => {
      switch (event.type) {
        case 'connected':
          setConnected(true);
          setError(null);
          break;
        case 'disconnected':
          setConnected(false);
          break;
        case 'connection_error':
          setConnected(false);
          setError(event.error?.message || 'Connection failed');
          break;
        case 'components_changed':
          setComponents(displaySystem.getComponents());
          break;
      }
    });

    // Connect to daemon
    displaySystem.connect();

    // Cleanup on unmount
    return () => {
      unsubscribe();
      displaySystem.disconnect();
    };
  }, [displaySystem]);

  return { components, connected, error };
};

// ========================
// MAIN APP
// ========================

export default function RealComponentRenderer() {
  const { components, connected, error } = useComponentDisplay();

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-2xl mx-auto px-4">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">
            Real Component Renderer
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
            Real GraphQL connection: Registry → Daemon → <strong>Renderer</strong>
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
          <h3 className="text-lg font-semibold text-gray-900">
            Components from Daemon: ({components.length})
          </h3>
          
          {!connected && !error && (
            <div className="text-center py-8 text-gray-500 bg-white rounded-lg">
              <div className="animate-spin w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full mx-auto mb-2"></div>
              Connecting to daemon...
            </div>
          )}

          {connected && components.length === 0 && (
            <div className="text-center py-8 text-gray-500 bg-white rounded-lg">
              Connected! Waiting for components from daemon...
              <div className="mt-4 text-xs text-gray-400">
                Try sending a component via the registry
              </div>
            </div>
          )}

          {components.map(component => {
            const ComponentRenderer = UIRenderers[component.type];
            
            if (!ComponentRenderer) {
              return (
                <div key={component.id} className="bg-red-100 border border-red-400 rounded p-4">
                  <p className="text-red-700">Unknown component type: {component.type}</p>
                  <pre className="text-xs mt-2 text-red-600">
                    {JSON.stringify(component, null, 2)}
                  </pre>
                </div>
              );
            }

            return (
              <div key={component.id} data-component-id={component.id}>
                <ComponentRenderer data={component.data} />
              </div>
            );
          })}
        </div>

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