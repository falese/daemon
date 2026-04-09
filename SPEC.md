# UI Control Plane Daemon — Project Specification

## Goal

Build a **control plane daemon** that sits between a UI renderer and a backend rules engine. The daemon monitors user actions from the renderer, routes them to the rules engine, and pushes back the resulting UI components — all in real time using WebSockets and GraphQL.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        RENDERER                              │
│  (React or HTML)  port 3000 / 8081                          │
│                                                              │
│  • Subscribes to Daemon via GraphQL WS subscription          │
│  • Sends user actions (CLICK, SUBMIT) via GraphQL mutation   │
│  • Renders components returned by the daemon                 │
└──────────────────────────┬───────────────────────────────────┘
                           │  GraphQL over WebSocket
                           │  (graphql-transport-ws protocol)
┌──────────────────────────▼───────────────────────────────────┐
│                         DAEMON                               │
│  (Node.js or Rust)  port 3001                               │
│                                                              │
│  • Exposes GraphQL server to renderers                       │
│  • Subscribes to Registry for component updates              │
│  • Maintains shared state: component store + action history  │
│  • Forwards renderer actions up to Registry                  │
│  • Broadcasts components down to all connected renderers     │
└──────────────────────────┬───────────────────────────────────┘
                           │  GraphQL over WebSocket
                           │  (graphql-transport-ws protocol)
┌──────────────────────────▼───────────────────────────────────┐
│                        REGISTRY                              │
│  (Node.js)  port 4000                                       │
│                                                              │
│  • Stores active components in memory                        │
│  • Evaluates rules when actions arrive                       │
│  • Publishes component updates via GraphQL subscription      │
│  • REST endpoint for direct component injection              │
└──────────────────────────────────────────────────────────────┘
```

---

## Shared State Object

The daemon maintains a single shared state object that is the source of truth for all connected renderers:

```typescript
interface SharedState {
  components: Map<string, Component>;   // active components keyed by id
  actions: ActionRecord[];              // capped history (last 50)
  lastUpdated: string;                  // ISO timestamp
}

interface Component {
  id: string;
  type: "CARD" | "NOTIFICATION" | "FORM" | "ACTION_ECHO" | "STATE_SNAPSHOT";
  data: Record<string, unknown>;        // component-specific payload
  createdAt: string;                    // ISO timestamp
}

interface ActionRecord {
  id: string;
  componentId: string;
  actionType: "CLICK" | "SUBMIT" | "BUTTON_CLICK";
  data: Record<string, unknown>;
  timestamp: string;
}
```

---

## Message Protocol

All messages flowing over WebSocket subscriptions share this envelope:

```typescript
interface Message {
  direction: "COMPONENT" | "ACTION";
  kind: MessageKind;
  payload: Component | ActionRecord;
  metadata: {
    correlationId: string;    // UUID, set at origin, carried end-to-end
    acknowledged: boolean;
    error: string | null;
  };
}

type MessageKind =
  | "COMPONENT_UPDATE"    // new or updated component pushed to renderer
  | "STATE_SNAPSHOT"      // full state dump (sent on connect and on request)
  | "ACTION_ECHO"         // daemon acknowledges receipt of renderer action
  | "ACTION_FORWARD"      // daemon forwarding action to registry
```

---

## GraphQL Schemas

### Registry Schema (port 4000)

```graphql
type Query {
  components: [Component!]!
  component(id: ID!): Component
}

type Mutation {
  renderComponent(type: ComponentType!, data: JSON): Component!
  handleMessage(message: MessageInput!): MessageResult!
}

type Subscription {
  componentUpdate: Component!
}

type Component {
  id: ID!
  type: ComponentType!
  data: JSON
  createdAt: String!
}

enum ComponentType {
  CARD
  NOTIFICATION
  FORM
  ACTION_ECHO
  STATE_SNAPSHOT
}
```

### Daemon Schema (port 3001)

```graphql
type Query {
  state: StateSnapshot!
}

type Mutation {
  sendAction(action: ActionInput!): ActionResult!
}

type Subscription {
  messages: Message!
}

type StateSnapshot {
  components: [Component!]!
  actions: [ActionRecord!]!
  lastUpdated: String!
}

type Message {
  direction: Direction!
  kind: MessageKind!
  payload: JSON!
  metadata: MessageMetadata!
}
```

---

## Rules Engine

The registry evaluates rules when `handleMessage` is called. Each rule is:

```typescript
interface Rule {
  id: string;
  name: string;
  condition: (component: Component, action: ActionRecord) => boolean;
  action: (component: Component, action: ActionRecord) => ComponentDraft;
}
```

### Default Rules

| Rule | Trigger | Output |
|------|---------|--------|
| `card-click` | CARD component + CLICK action | NOTIFICATION component |
| `form-submit` | FORM component + SUBMIT action | CARD component with submitted data |

---

## Data Flows

### Component Flow (down: Registry → Daemon → Renderer)

1. Component created via REST `POST /render` or GraphQL `renderComponent` mutation on Registry
2. Registry stores component, fires `componentUpdate` subscription event
3. Daemon (subscribed to Registry) receives event, stores in local state
4. Daemon broadcasts `COMPONENT_UPDATE` message to all connected renderers
5. Renderer receives message, adds/updates component in UI

### Action Flow (up: Renderer → Daemon → Registry)

1. User interacts with a component in the renderer
2. Renderer sends `sendAction` mutation to Daemon with `correlationId`
3. Daemon stores action in history, sends `ACTION_ECHO` back to renderer
4. Daemon forwards action to Registry via `handleMessage` mutation
5. Registry evaluates rules, may create new components
6. New components travel back down via the Component Flow

---

## Connection Lifecycle

### Renderer → Daemon

- Protocol: `graphql-transport-ws`
- On connect: Daemon sends `STATE_SNAPSHOT` with current state
- On reconnect: Same as connect (renderer rebuilds state from snapshot)
- Backoff: exponential, max 5 retries, cap 30 seconds

### Daemon → Registry

- Protocol: `graphql-transport-ws`  
- Persistent subscription connection for `componentUpdate`
- Separate short-lived mutation connections for `handleMessage` (fire-and-forget with timeout)
- On disconnect: Daemon retries with exponential backoff, logs warning to renderers

---

## Implementation Variants

Two daemon implementations exist for evaluation:

| | Node.js Daemon | Rust Daemon |
|---|---|---|
| **Port** | 3002 | 3001 |
| **Runtime** | Node.js 20 | Tokio async runtime |
| **GraphQL** | graphql-ws + apollo | async-graphql + warp |
| **State** | JS Map | DashMap (concurrent) |
| **Broadcast** | EventEmitter | tokio::broadcast |
| **Status** | Reference implementation | Performance variant |

The Node.js daemon is the **reference implementation**. The Rust daemon is a performance-oriented variant. They implement the same protocol and are interchangeable.

---

## Configuration

All services are configured via environment variables:

| Variable | Default | Description |
|---|---|---|
| `REGISTRY_WS_URL` | `ws://registry:4000/graphql` | Full WebSocket URL to registry |
| `REGISTRY_HOST` | `registry` | Registry hostname (used if URL not set) |
| `REGISTRY_PORT` | `4000` | Registry port (used if URL not set) |
| `DAEMON_PORT` | `3001` | Port daemon listens on |
| `LOG_JSON` | unset | If set, emit JSON structured logs |
| `NODE_ENV` | `development` | Node.js environment |

---

## Component Types Reference

### CARD
```json
{ "title": "string", "content": "string", "buttons": [{"label": "string", "action": "string"}] }
```

### NOTIFICATION
```json
{ "message": "string", "status": "SUCCESS|ERROR|WARNING|INFO" }
```

### FORM
```json
{ "title": "string", "fields": [{"name": "string", "label": "string", "type": "text|email|select"}] }
```

### ACTION_ECHO
```json
{ "originalAction": "ActionRecord", "receivedAt": "ISO timestamp" }
```

### STATE_SNAPSHOT
```json
{ "components": [...], "actions": [...], "lastUpdated": "ISO timestamp" }
```

---

## Out of Scope (for this prototype)

- Authentication / authorization on GraphQL endpoints
- Persistent storage (all state is in-memory)
- Component TTL / eviction policy
- Rate limiting
- Multi-daemon coordination
