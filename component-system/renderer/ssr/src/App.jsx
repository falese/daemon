import { useState, useEffect, useCallback, useRef } from 'react';

// ── Slot helpers ──────────────────────────────────────────────────────────────

function buildSlotMap(assignments = []) {
  const map = new Map();
  for (const { parentComponentId, slotName, childComponentId } of assignments) {
    if (!map.has(parentComponentId)) map.set(parentComponentId, new Map());
    map.get(parentComponentId).set(slotName, childComponentId ?? null);
  }
  return map;
}

function isSlotted(slotMap, id) {
  for (const byName of slotMap.values())
    for (const childId of byName.values())
      if (childId === id) return true;
  return false;
}

function resolveSlots(slotMap, componentMap, parentId) {
  const byName = slotMap.get(parentId);
  if (!byName) return {};
  const out = {};
  for (const [name, childId] of byName)
    out[name] = childId ? (componentMap.get(childId) ?? null) : null;
  return out;
}

// ── WebSocket client (client-only — never imported during SSR render) ─────────

class GraphQLWSClient {
  constructor({ port, onConnected, onDisconnected, onEnvelope }) {
    this.url = `ws://${window.location.hostname}:${port}/graphql`;
    this.onConnected = onConnected;
    this.onDisconnected = onDisconnected;
    this.onEnvelope = onEnvelope;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.stopped = false;
  }

  connect() {
    if (this.stopped) return;
    this.ws = new WebSocket(this.url, 'graphql-transport-ws');
    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this._send({ type: 'connection_init' });
    };
    this.ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'connection_ack') {
        this.onConnected?.();
        this._send({
          id: 'ssr-sub', type: 'subscribe',
          payload: {
            query: `subscription { messages { direction kind payload metadata { acknowledged correlationId error } } }`
          }
        });
      } else if (msg.type === 'next') {
        this.onEnvelope?.(msg.payload?.data?.messages);
      } else if (msg.type === 'ping') {
        this._send({ type: 'pong' });
      }
    };
    this.ws.onclose = () => {
      this.onDisconnected?.();
      if (!this.stopped) {
        const delay = Math.min(5000, 400 * 1.6 ** this.reconnectAttempts++);
        setTimeout(() => this.connect(), delay);
      }
    };
  }

  sendMessage(envelope) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this._send({
        id: `m-${Date.now()}`, type: 'subscribe',
        payload: {
          query: `mutation SendMessage($m: String!) { sendMessage(message: $m) }`,
          variables: { m: JSON.stringify(envelope) }
        }
      });
    }
  }

  stop() { this.stopped = true; this.ws?.close(); }
  _send(obj) { this.ws?.send(JSON.stringify(obj)); }
}

// ── UI Renderers ──────────────────────────────────────────────────────────────

const RuleEvaluation = ({ evalData }) => {
  if (!evalData) return null;
  const { rule, facts = {}, result } = evalData;
  const fmt = (v) => v == null ? 'null' : typeof v === 'object' ? JSON.stringify(v) : String(v);
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
            {k}: {fmt(v)}
          </span>
        ))}
      </div>
    </div>
  );
};

// eslint-disable-next-line no-use-before-define
const SlotRenderer = ({ component, onAction }) => {
  if (!component) {
    return (
      <div className="border border-dashed border-gray-300 rounded p-3 text-center text-gray-400 text-xs">
        Empty slot
      </div>
    );
  }
  const Renderer = UIRenderers[component.type];
  if (!Renderer) return null;
  return <Renderer data={component.data} componentId={component.id} onAction={onAction} slots={{}} slotNames={[]} />;
};

const UIRenderers = {
  CARD: ({ data, componentId, onAction, slots = {}, slotNames = [] }) => (
    <div
      className="max-w-sm mx-auto bg-white rounded-lg shadow-md p-6 mb-4 cursor-pointer hover:shadow-lg transition-shadow"
      onClick={() => onAction(componentId, 'CLICK', { timestamp: new Date().toISOString() })}
    >
      {data.title   && <h2 className="text-xl font-bold text-gray-900 mb-2">{data.title}</h2>}
      {data.content && <p className="text-gray-600">{data.content}</p>}
      {slotNames.includes('detail') && (
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
      INFO:    'bg-blue-100 border-blue-400 text-blue-700',
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
    const [formData, setFormData] = useState({});
    return (
      <form
        onSubmit={e => { e.preventDefault(); onAction(componentId, 'SUBMIT', formData); }}
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
                onChange={e => setFormData(prev => ({ ...prev, [field.name || field.label]: e.target.value }))}
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
  },
};

// ── App ───────────────────────────────────────────────────────────────────────

export default function App({ initialState = { components: [], slotAssignments: [] } }) {
  const [componentMap, setComponentMap] = useState(() => {
    const m = new Map();
    for (const c of initialState.components) m.set(c.id, c);
    return m;
  });
  const [slotMap, setSlotMap] = useState(() => buildSlotMap(initialState.slotAssignments));
  const [connected, setConnected] = useState(false);
  const wsRef = useRef(null);

  // Stable reference — doesn't change when wsRef.current changes
  const onAction = useCallback((componentId, actionType, data) => {
    wsRef.current?.sendMessage({
      direction: 'ACTION',
      payload: {
        id:          `a-${Date.now()}`,
        componentId,
        actionType,
        data,
        timestamp:   new Date().toISOString()
      },
      metadata: { acknowledged: false, correlationId: `a-${Date.now()}`, error: null },
    });
  }, []);

  useEffect(() => {
    // Port resolution: ?daemonPort= query param → window.__DAEMON_PORT__ → 3001
    const qp = new URLSearchParams(window.location.search).get('daemonPort');
    const port = qp || window.__DAEMON_PORT__ || '3001';

    const client = new GraphQLWSClient({
      port,
      onConnected:    () => setConnected(true),
      onDisconnected: () => setConnected(false),
      onEnvelope: (envelope) => {
        if (!envelope || envelope.direction !== 'COMPONENT') return;
        const { kind, payload } = envelope;

        if (kind === 'SLOT_ASSIGNMENT') {
          const { parentComponentId, slotName, childComponentId } = payload;
          setSlotMap(prev => {
            const next = new Map(prev);
            const inner = new Map(next.get(parentComponentId));
            inner.set(slotName, childComponentId ?? null);
            next.set(parentComponentId, inner);
            return next;
          });
          return;
        }

        let component;
        if (kind === 'STATE_SNAPSHOT' && payload?.component) {
          component = payload.component;
        } else {
          component = payload;
        }
        if (!component?.id || !component?.type) return;

        setComponentMap(prev => {
          const next = new Map(prev);
          next.set(component.id, component);
          return next;
        });
      },
    });

    wsRef.current = client;
    client.connect();
    return () => client.stop();
  }, []);

  const components = Array.from(componentMap.values());
  const topLevel   = components.filter(c => !isSlotted(slotMap, c.id));

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-2xl mx-auto px-4">

        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">SSR Renderer</h1>
          <div className="flex items-center justify-center space-x-2 mb-2">
            <div className={`w-3 h-3 rounded-full ${connected ? 'bg-green-500' : 'bg-yellow-500'}`} />
            <span className="text-sm text-gray-600">
              {connected ? 'Connected to Daemon' : 'Connecting…'}
            </span>
          </div>
          <p className="text-gray-500 text-sm">Registry → Daemon → <strong>SSR Renderer</strong></p>
        </div>

        <div className="bg-white rounded-lg shadow p-4 mb-6 text-xs text-gray-500 space-y-1">
          <p>
            <strong className="text-gray-700">Server-rendered</strong> — HTML built on the server with a
            snapshot of live components before the first byte was sent.
          </p>
          <p>Client hydrates and subscribes to the daemon WebSocket for live updates.</p>
        </div>

        <div className="bg-white rounded-lg shadow p-4 mb-6 text-sm space-y-2">
          <div className="flex items-center space-x-2">
            <span className="w-5 h-5 bg-blue-500 text-white rounded text-xs flex items-center justify-center">1</span>
            <span><strong>Registry</strong> — rules engine (port 4000)</span>
          </div>
          <div className="ml-4 text-gray-400 text-xs">↓ GraphQL subscription</div>
          <div className="flex items-center space-x-2">
            <span className="w-5 h-5 bg-green-500 text-white rounded text-xs flex items-center justify-center">2</span>
            <span><strong>Daemon</strong> — routes components &amp; actions (port 3001)</span>
          </div>
          <div className="ml-4 text-gray-400 text-xs">↓ HTTP snapshot + WS subscription</div>
          <div className="flex items-center space-x-2">
            <span className={`w-5 h-5 text-white rounded text-xs flex items-center justify-center ${connected ? 'bg-purple-500' : 'bg-gray-400'}`}>3</span>
            <span><strong>SSR Renderer</strong> — this app ({connected ? 'live' : 'hydrating'})</span>
          </div>
        </div>

        <h3 className="text-lg font-semibold text-gray-900 mb-3">
          Live Components ({topLevel.length})
        </h3>

        {topLevel.length === 0 && (
          <p className="text-gray-400 text-sm mb-4">
            No components yet. Run{' '}
            <code className="bg-gray-100 px-1 rounded">make form</code> to inject one.
          </p>
        )}

        {topLevel.map(component => {
          const Renderer = UIRenderers[component.type];
          if (!Renderer) return null;
          const slots    = resolveSlots(slotMap, componentMap, component.id);
          const slotNames = component.slots || [];
          return (
            <div key={component.id}>
              <Renderer
                data={component.data}
                componentId={component.id}
                onAction={onAction}
                slots={slots}
                slotNames={slotNames}
              />
            </div>
          );
        })}

      </div>
    </div>
  );
}
