# UI Control Plane Daemon — Project Specification

## Goal

Build a **control plane daemon** that sits between a UI renderer and a backend rules engine. The daemon monitors user actions from the renderer, routes them to the rules engine, and pushes back the resulting UI components — all in real time using WebSockets and GraphQL.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        RENDERER                              │
│  (React CSR / HTML / React SSR)  port 3000 / 8081 / 3003   │
│                                                              │
│  • Subscribes to Daemon via GraphQL WS subscription          │
│  • Sends user actions (CLICK, SUBMIT) via GraphQL mutation   │
│  • Renders components returned by the daemon                 │
│  • SSR variant: fetches initial state via HTTP on each       │
│    request, streams HTML, then hydrates for live updates     │
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
  type: "CARD" | "NOTIFICATION" | "FORM" | "ACTION_ECHO" | "STATE_SNAPSHOT" | string;
  data: Record<string, unknown>;        // component-specific payload
  createdAt: string;                    // ISO timestamp
  slots?: string[];                     // named holes this component exposes (e.g. ["detail"])
}

interface SlotAssignment {
  parentComponentId: string;
  slotName: string;
  childComponentId: string | null;      // null = slot is cleared
}

interface ActionRecord {
  id: string;
  componentId: string;
  actionType: "CLICK" | "SUBMIT" | "BUTTON_CLICK";
  data: Record<string, unknown>;
  timestamp: string;
}
```

The daemon also maintains `slotAssignments: Map<parentId, Map<slotName, childId | null>>` — the authoritative map of what fills each declared slot. Only the daemon writes this map; renderers read it via `SLOT_ASSIGNMENT` messages.

---

## Message Protocol

All messages flowing over WebSocket subscriptions share this envelope:

```typescript
interface Message {
  direction: "COMPONENT" | "ACTION";
  kind: MessageKind;
  payload: Component | ActionRecord | SlotAssignment;
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
  | "SLOT_ASSIGNMENT"     // daemon notifies renderers that a slot's occupant changed
```

`SLOT_ASSIGNMENT` always precedes the `COMPONENT_UPDATE` for the same child component in the same flush. Renderers store the child ID (not the object) and resolve it lazily on each render to handle this ordering safely.

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
  state:           StateSnapshot!
  components:      [Component!]!
  slotAssignments: [SlotAssignment!]!
}

type Mutation {
  sendMessage(message: String!): Boolean!
  # Directly assign a component to a named slot (bypasses registry rules).
  # Pass childId: null to clear the slot.
  assignSlot(parentId: String!, slotName: String!, childId: String): Boolean!
}

type Subscription {
  messages: Message!
}

type Component {
  id:        ID!
  type:      String!
  data:      JSON
  createdAt: String!
  slots:     [String!]   # named holes this component exposes
}

type SlotAssignment {
  parentComponentId: String!
  slotName:          String!
  childComponentId:  String   # null = slot is empty
}

type StateSnapshot {
  components: [Component!]!
  actions:    [ActionRecord!]!
  lastUpdated: String!
}

type Message {
  direction: Direction!
  kind:      MessageKind!
  payload:   JSON!
  metadata:  MessageMetadata!
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
| `card-click` | CARD component + CLICK action | NOTIFICATION with `data._slot = { parentId, slotName: 'detail' }` — slotted inside the CARD |
| `form-submit` | FORM component + SUBMIT action | CARD with `slots: ['detail']` and submitted data |

The `_slot` field in `data` is a routing *intent* read and consumed by the daemon. It is not stripped before forwarding — renderers receive it in `data` but ignore it (they read only the `slots` prop passed from the display system).

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

## Slot Composition

The daemon enforces a strict separation of concerns around slot assignment:

| Layer | Responsibility |
|---|---|
| **Component** (`slots: string[]`) | Declaring that a named slot exists |
| **Registry rule** (`data._slot`) | Expressing routing *intent* (which slot a generated component should fill) |
| **Daemon** (`slotAssignments` map) | Single source of truth; validates and broadcasts assignments |
| **Renderer** (`slotMap`) | Displaying whatever the daemon assigned; never selecting slot contents |

### Slot assignment data flow

1. Registry rule generates a component with `data._slot = { parentId, slotName }`.
2. Daemon's `storeComponent` calls `resolveSlotAssignment`:
   - Validates `parent.slots.includes(slotName)`.
   - Updates `slotAssignments` map.
   - Publishes `SLOT_ASSIGNMENT` then `COMPONENT_UPDATE` (in that order).
3. Renderer receives `SLOT_ASSIGNMENT` → stores child *ID* in `slotMap`.
4. Renderer receives `COMPONENT_UPDATE` → stores child *object* in `components`.
5. On next render, `getSlots(parentId)` resolves ID → object from the component map.

Storing the ID rather than the object in step 3 handles the guaranteed ordering (slot assignment before component update) without any race condition.

---

## Renderer Variants

Three renderer implementations share the same daemon protocol:

| | React CSR | HTML | React SSR |
|---|---|---|---|
| **Port** | 3000 | 8081 | 3003 |
| **Initial paint** | Empty shell, components load after WS connects | Same | Full HTML with live component data |
| **Live updates** | WebSocket subscription | WebSocket subscription | WebSocket subscription (after hydration) |
| **Build** | Create React App | None | Vite (client + SSR bundle) |
| **Slots** | Yes | Yes | Yes |

The SSR renderer fetches `components` and `slotAssignments` from the daemon via HTTP before rendering, serialises the state into `window.__INITIAL_STATE__`, and hydrates with `hydrateRoot` on the client. The first paint always reflects the live state at request time.

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
| **Slot composition** | Yes (`assignSlot` mutation) | No (not yet implemented) |
| **Status** | Reference implementation | Performance variant |

The Node.js daemon is the **reference implementation**. The Rust daemon is a performance-oriented variant. They implement the same protocol and are interchangeable for features that both support.

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
