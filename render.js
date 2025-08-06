import React, { useState, useEffect } from 'react';

// ========================
// SIMPLE COMPONENT RENDERER
// React app that connects to daemon and renders components
// ========================

// ========================
// DAEMON CLIENT
// ========================

class DaemonClient {
  constructor() {
    this.subscriptions = new Map();
    this.connected = false;
  }

  connect() {
    console.log('🔌 Renderer: Connecting to daemon...');
    setTimeout(() => {
      this.connected = true;
      console.log('✅ Renderer: Connected to daemon');
      this.simulateDaemonData();
    }, 1000);
  }

  subscribe(callback) {
    const id = 'daemon-sub';
    this.subscriptions.set(id, callback);
    console.log('📡 Renderer: Subscribed to daemon');
    return () => this.subscriptions.delete(id);
  }

  // Simulate receiving data from daemon
  simulateDaemonData() {
    const components = [
      {
        id: 'welcome-1',
        type: 'CARD',
        data: {
          title: 'Hello from Registry!',
          content: 'This component traveled: Registry → Daemon → Renderer'
        },
        createdAt: new Date().toISOString()
      },
      {
        id: 'status-1',
        type: 'NOTIFICATION',
        data: {
          message: 'Renderer successfully connected to daemon',
          type: 'SUCCESS'
        },
        createdAt: new Date().toISOString()
      }
    ];

    components.forEach((component, index) => {
      setTimeout(() => {
        console.log('📦 Renderer: Received component from daemon:', component.id);
        this.subscriptions.forEach(callback => {
          callback({ data: { rendererUpdate: component } });
        });
      }, (index + 1) * 2000);
    });
  }
}

// ========================
// RENDERING SYSTEM
// ========================

class RenderingSystem {
  constructor() {
    this.daemonClient = new DaemonClient();
    this.components = new Map();
    this.subscribers = new Set();
  }

  async connect() {
    this.daemonClient.connect();
    
    // Subscribe to daemon
    this.daemonClient.subscribe((result) => {
      if (result.data?.rendererUpdate) {
        this.handleComponentFromDaemon(result.data.rendererUpdate);
      }
    });

    this.notify({ type: 'connected' });
  }

  handleComponentFromDaemon(component) {
    console.log(`📦 Renderer: Rendering component ${component.id}`);
    
    this.components.set(component.id, component);
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
// COMPONENT RENDERERS
// ========================

const ComponentRenderers = {
  CARD: ({ data }) => (
    <div className="max-w-sm mx-auto bg-white rounded-lg shadow-md p-6 mb-4">
      {data.title && (
        <h2 className="text-xl font-bold text-gray-900 mb-2">{data.title}</h2>
      )}
      {data.content && (
        <p className="text-gray-600">{data.content}</p>
      )}
    </div>
  ),

  NOTIFICATION: ({ data }) => {
    const bgColor = {
      SUCCESS: 'bg-green-100 border-green-400 text-green-700',
      ERROR: 'bg-red-100 border-red-400 text-red-700',
      INFO: 'bg-blue-100 border-blue-400 text-blue-700'
    }[data.type] || 'bg-gray-100 border-gray-400 text-gray-700';

    return (
      <div className={`max-w-sm mx-auto border rounded p-4 mb-4 ${bgColor}`}>
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
              className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:border-blue-500"
            />
          </div>
        ))}
        <button className="w-full px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600">
          Submit
        </button>
      </div>
    </div>
  )
};

// ========================
// REACT HOOKS
// ========================

const useRenderer = () => {
  const [renderer] = useState(() => new RenderingSystem());
  const [components, setComponents] = useState([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const unsubscribe = renderer.subscribe((event) => {
      switch (event.type) {
        case 'connected':
          setConnected(true);
          break;
        case 'components_changed':
          setComponents(renderer.getComponents());
          break;
      }
    });

    renderer.connect();

    return unsubscribe;
  }, [renderer]);

  return { components, connected };
};

// ========================
// MAIN APP - THIS IS THE RENDERER
// ========================

export default function SimpleComponentRenderer() {
  const { components, connected } = useRenderer();

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-2xl mx-auto px-4">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">
            Component Renderer (React App)
          </h1>
          <div className="flex items-center justify-center space-x-2 mb-2">
            <div className={`w-3 h-3 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`}></div>
            <span className="text-sm text-gray-600">
              {connected ? 'Connected to Daemon' : 'Disconnected'}
            </span>
          </div>
          <p className="text-gray-600">
            This React app is the final step: Registry → Daemon → <strong>Renderer</strong>
          </p>
        </div>

        {/* Flow Diagram */}
        <div className="bg-white rounded-lg shadow p-6 mb-8">
          <h3 className="font-bold mb-4">Complete Flow</h3>
          <div className="text-sm space-y-3">
            <div className="flex items-center space-x-2">
              <div className="w-4 h-4 bg-blue-500 rounded flex items-center justify-center text-white text-xs">1</div>
              <span><strong>Component Registry</strong> (Node.js, port 4000) publishes components</span>
            </div>
            <div className="ml-4 text-gray-500">↓ GraphQL Subscription</div>
            <div className="flex items-center space-x-2">
              <div className="w-4 h-4 bg-green-500 rounded flex items-center justify-center text-white text-xs">2</div>
              <span><strong>Component Daemon</strong> (Node.js, port 3001) receives & forwards</span>
            </div>
            <div className="ml-4 text-gray-500">↓ GraphQL Subscription</div>
            <div className="flex items-center space-x-2">
              <div className="w-4 h-4 bg-purple-500 rounded flex items-center justify-center text-white text-xs">3</div>
              <span><strong>Component Renderer</strong> (This React App) renders UI</span>
            </div>
          </div>
        </div>

        {/* Components from Daemon */}
        <div className="space-y-4">
          <h3 className="text-lg font-semibold text-gray-900">Components from Daemon:</h3>
          {components.length === 0 ? (
            <div className="text-center py-8 text-gray-500 bg-white rounded-lg">
              {connected ? 'Waiting for components from daemon...' : 'Connecting to daemon...'}
            </div>
          ) : (
            components.map(component => {
              const Renderer = ComponentRenderers[component.type];
              
              if (!Renderer) {
                return (
                  <div key={component.id} className="bg-red-100 border border-red-400 rounded p-4">
                    <p className="text-red-700">Unknown component type: {component.type}</p>
                  </div>
                );
              }

              return (
                <div key={component.id} data-component-id={component.id}>
                  <Renderer data={component.data} />
                </div>
              );
            })
          )}
        </div>

        {/* Debug */}
        {components.length > 0 && (
          <details className="mt-8 bg-white rounded p-4">
            <summary className="cursor-pointer font-medium">
              Debug: {components.length} components received
            </summary>
            <pre className="mt-2 text-xs bg-gray-100 p-3 rounded overflow-auto">
              {JSON.stringify(components, null, 2)}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}