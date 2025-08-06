import React, { useState, useEffect } from 'react';

// ========================
// GRAPHQL WEBSOCKET CLIENT
// ========================

class GraphQLWebSocketClient {
  constructor(url = 'ws://localhost:3001/graphql') {
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
        this.ws = new WebSocket(this.url, 'graphql-ws');
        
        this.ws.onopen = () => {
          console.log('✅ Renderer: WebSocket opened to daemon');
          this.connected = true;
          this.reconnectAttempts = 0;
          
          console.log('📡 Renderer: Sending connection_init to daemon');
          this.send({ type: 'connection_init' });
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
        
      case 'data':
        console.log('📨 Renderer: Data message received:', message);
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
// RENDERING SYSTEM
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
// UI RENDERERS
// ========================

const UIRenderers = {
  CARD: ({ data }) => (
    <div className="component-card">
      {data.title && <h2 className="card-title">{data.title}</h2>}
      {data.content && <p className="card-content">{data.content}</p>}
      {data.buttons && (
        <div className="card-buttons">
          {data.buttons.map((button, index) => (
            <button key={index} className="card-button">
              {button.text}
            </button>
          ))}
        </div>
      )}
    </div>
  ),

  NOTIFICATION: ({ data }) => (
    <div className={`notification ${(data.type || 'info').toLowerCase()}`}>
      {data.title && <h3 className="notification-title">{data.title}</h3>}
      <p className="notification-message">{data.message}</p>
    </div>
  ),

  FORM: ({ data }) => (
    <div className="form-container">
      {data.title && <h2 className="form-title">{data.title}</h2>}
      <div className="form-fields">
        {data.fields?.map((field, index) => (
          <div key={index} className="form-field">
            <label>{field.label}</label>
            <input
              type={field.type?.toLowerCase() || 'text'}
              placeholder={field.placeholder}
            />
          </div>
        ))}
        <button className="form-submit">
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

    displaySystem.connect();

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
    <div className="app-container">
      <div className="main-content">
        {/* Header */}
        <div className="header">
          <h1 className="app-title">Component Renderer</h1>
          <div className="status-indicator">
            <div className={`status-dot ${connected ? 'connected' : error ? 'error' : 'connecting'}`}></div>
            <span className="status-text">
              {connected ? 'Connected to Daemon' : 
               error ? `Error: ${error}` : 'Connecting...'}
            </span>
          </div>
          <p className="subtitle">
            Real-time components from Registry → Daemon → <strong>Renderer</strong>
          </p>
        </div>

        {/* Status Card */}
        <div className="card">
          <h3>System Status</h3>
          <p><strong>Registry:</strong> localhost:4000</p>
          <p><strong>Daemon:</strong> localhost:3001</p>
          <p><strong>Renderer:</strong> {connected ? 'CONNECTED' : 'DISCONNECTED'}</p>
        </div>

        {/* Error Display */}
        {error && (
          <div className="notification error">
            <h3 className="notification-title">Connection Error</h3>
            <p className="notification-message">{error}</p>
            <p className="notification-message">Make sure the Component Daemon is running on port 3001</p>
          </div>
        )}

        {/* Components Section */}
        <div>
          <h3 className="section-title">Live Components ({components.length})</h3>
          
          {!connected && !error && (
            <div className="empty-state">
              <div className="spinner"></div>
              Connecting to daemon...
            </div>
          )}

          {connected && components.length === 0 && (
            <div className="empty-state">
              Connected! Waiting for components from daemon...
              <div style={{marginTop: '16px', fontSize: '12px', color: '#9ca3af'}}>
                Try sending a component via the registry
              </div>
            </div>
          )}

          {/* Dynamic Components */}
          {components.map(component => {
            const ComponentRenderer = UIRenderers[component.type];
            
            if (!ComponentRenderer) {
              return (
                <div key={component.id} className="notification error">
                  <p>Unknown component type: {component.type}</p>
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

        {/* Test Instructions */}
        <div className="card" style={{backgroundColor: '#eff6ff', borderColor: '#bfdbfe'}}>
          <h3 style={{color: '#1e40af'}}>Test the System</h3>
          <p style={{color: '#1e40af', fontSize: '14px'}}>Send a component:</p>
          <pre style={{backgroundColor: '#dbeafe', padding: '8px', borderRadius: '4px', fontSize: '12px', color: '#1e40af'}}>
{`curl -X POST http://localhost:4000/render \\
  -H "Content-Type: application/json" \\
  -d '{
    "type": "CARD",
    "data": {
      "title": "Beautiful Component!",
      "content": "This looks much better now!"
    }
  }'`}
          </pre>
        </div>
      </div>
    </div>
  );
}