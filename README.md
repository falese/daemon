# Vibe Coded Slop Daemon

A distributed, real-time component rendering system built with GraphQL, Rust, Node.js, and React. This architecture enables dynamic UI updates across multiple renderers through a high-performance daemon service.

![Architecture](https://img.shields.io/badge/Architecture-Microservices-blue)
![Rust](https://img.shields.io/badge/Rust-Daemon-orange)
![GraphQL](https://img.shields.io/badge/GraphQL-Subscriptions-E10098)
![React](https://img.shields.io/badge/React-Frontend-61DAFB)
![Docker](https://img.shields.io/badge/Docker-Containers-2496ED)

## 🏗️ Architecture Overview

```
┌─────────────────┐                   ┌─────────────────┐                   ┌─────────────────┐
│   Component     │◄──── State ───────│   Component     │       WebSocket   │   Frontend      │
│   Registry      │                   │   Daemon        │◄───────────────►  │   Renderer      │
│   (Backend)     │                   │   (Middleware)  │    Components     │   (React App)   │
│                 │                   │                 │     & Actions     │                 │
│  • Manages      │                   │  • Maintains    │                   │  • Renders UI   │
│    Components   │    Components     │    State        │                   │  • Handles      │
│  • Rules Engine │─────────────────► │  • Message      │                   │    User Input   │
│  • REST API     │                   │    Router       │                   │  • Processes    │
│  • GraphQL      │                   │  • State        │                   │    Actions      │
│    Publishing   │                   │    Machine      │                   │                 │
└─────────────────┘                   └─────────────────┘                   └─────────────────┘
      Port 4000                             Port 3001                           Port 3000
```

### Message Flow (High Level)

1. User interacts with component in Renderer
2. Action sent via WebSocket to Daemon
3. Daemon updates internal state
4. State sent to Registry
5. Registry rules generate new component
6. Component flows back through WebSocket

### State / Action Flow (Expanded Summary)

1. User clicks button in Renderer
2. Action sent to Daemon
3. Daemon updates internal state
4. State sent to Registry
5. Registry rules generate new component
6. Component flows back through system

## 📡 Core Data Flows

This system has two primary real-time flows:

1. Component Flow (Backend → Frontend): Registry generates/publishes components that propagate through a daemon to renderers.
2. Action Flow (Frontend → Backend): User interactions become actions that travel back through the daemon to the registry, trigger rules, and cause new components.

### 1. Component Flow (Registry → Daemon → Renderer)

High-level:

1. A component is created (REST `/render`, GraphQL `renderComponent`, or a rule firing).
2. Registry stores state and publishes a GraphQL subscription event (`componentUpdate`).
3. Daemon maintains a `graphql-transport-ws` subscription to `componentUpdate` and receives the component.
4. Daemon caches component state and broadcasts it via its own GraphQL subscription endpoint to connected renderers.
5. Renderer renders/updates UI.

Sequence (ASCII):

```
Client (curl)          Registry                  Daemon                    Renderer
     | POST /render --> |                         |                          |
     |                  | store component         |                          |
     |                  | publish componentUpdate |                          |
     |                  | ---- subscription ----> |                          |
     |                  |                         | cache & forward          |
     |                  |                         | ---- subscription ---->  | render
```

Key Messages:

- Registry → Daemon (WebSocket subscription event):
  `{ direction: 'COMPONENT', payload: { id, type, data, createdAt } }`
- Daemon → Renderer: Similar shape (through async-graphql subscription).

Correlating Logs:

- Registry: `📦 Registry: Publishing new component <id>`
- Daemon: `📦 Daemon: Received component from registry: <id>` (or custom log message) then `📦 Daemon: Forwarding component ...`
- Renderer (if logging): `📦 Renderer: Received component` (React/HTML implementation dependent)

Troubleshooting Component Flow:

- No components at renderer: Ensure renderer connected to daemon WebSocket (browser console / network tab).
- Daemon not receiving: Check daemon logs for successful `connection_ack` and `Sent subscribe` lines.
- Registry publishing but daemon silent: Verify subprotocol `graphql-transport-ws` and that no disconnect loops occur (WS code 1006 hints at protocol mismatch).

### 2. Action Flow (Renderer → Daemon → Registry → New Component)

High-level:

1. User interacts with a rendered component (e.g., submits a FORM or clicks button).
2. Renderer sends an ACTION message to the daemon (UI → daemon GraphQL mutation or WS depending on renderer implementation).
3. Daemon updates local state (adds action to component state).
4. Daemon forwards the original ACTION to Registry using a one-off GraphQL WebSocket mutation `handleMessage(message: String!)` (current implementation opens a short-lived mutation WS, waits for `connection_ack`, sends mutation, waits for `next`/`complete`).
5. Registry receives the message, identifies it as `ACTION`, loads current component state, runs rule set.
6. Matching rule(s) generate new component(s); registry publishes them (Component Flow resumes for those components).

Sequence (ASCII):

```
User UI          Renderer            Daemon                    Registry                Daemon (sub)         Renderer
  | click/submit |                   |                         |                       |                     |
  | -- ACTION -->| (send to daemon)  | handle_action()         |                       |                     |
  |              | ----------------> | cache + spawn mutation  |                       |                     |
  |              |                   | -- WS connect --------> |                       |                     |
  |              |                   | connection_init         |                       |                     |
  |              |                   | <--- connection_ack ----|                       |                     |
  |              |                   | send handleMessage      |                       |                     |
  |              |                   | ----------------------->| handleAction + rules  |                     |
  |              |                   |                         | publish component ----|--> sub event ------>| render
```

Action JSON (logical shape):

```json
{
  "direction": "ACTION",
  "payload": {
    "id": "action-<ts>",
    "componentId": "<component-id>",
    "actionType": "SUBMIT|CLICK|...",
    "data": {
      /* form/button payload */
    },
    "timestamp": "2025-...Z"
  },
  "metadata": { "acknowledged": false, "correlationId": "...", "error": null }
}
```

Log Correlation (Happy Path SUBMIT):

1. Daemon: `[Daemon] Received ACTION message` (Rust log) / `Received ACTION`.
2. Daemon: `Mutation WS connected for handleMessage`.
3. Daemon: `Sending handleMessage mutation over WS (after ack)`.
4. Registry: `📨 Registry GraphQL: Handling message` → `🎯 Registry: Processing action for component ...`.
5. Registry: `🧪 Registry: Evaluating rules ...` → `🔍 Rule 'form-submit' condition => true` → `✨ Rule 'form-submit' triggered`.
6. Registry: `📦 Registry: Publishing new component <new-id>`.
7. Daemon: `📦 Daemon: Received component from registry: <new-id>`.
8. Renderer: new component appears.

Common Failure Points & Remedies:

| Symptom                                            | Likely Cause                                       | Fix                                                                                                 |
| -------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Registry logs show action but `No rules triggered` | Rule condition mismatch (e.g., wrong `actionType`) | Confirm `actionType` string & component type casing                                                 |
| Registry never logs `Processing action`            | Mutation not sent / WS failed                      | Check daemon mutation logs & ensure connection_ack before send                                      |
| WS code 1006 right after mutation send             | GraphQL parse error (double braces)                | Ensure mutation is `mutation handleMessage($message: String!) { handleMessage(message: $message) }` |
| Rule triggers but renderer silent                  | Daemon not forwarding subscription event           | Check daemon subscription still active (no reconnect spam)                                          |
| Multiple duplicate components                      | Action retried or form posted multiple times       | Deduplicate in renderer or add idempotency (future enhancement)                                     |

### Deep Dive: Why a Separate Mutation WS per Action?

Current design opens a short-lived WebSocket for each action mutation to guarantee protocol parity (`graphql-transport-ws`) and isolate failures. Potential optimizations:

- Reuse existing subscription connection for mutations (spec supports queries/mutations over same session).
- Batch actions and send via a queue + single persistent mutation channel.
- Add ack message back to renderer to reflect processing completion.

### Future Enhancements (Suggested)

- Correlation/Ack Flow: Registry returns a success payload → daemon updates metadata. Renderer displays processing status.
- Rule Introspection Endpoint: `query { rules { name description firedCount } }` for monitoring.
- Metrics: Counters for actions processed and components generated (Prometheus endpoint).
- Persistence: Optional durable store for components/actions to survive restarts.
- Security: API keys or auth tokens on WebSocket connection_init payload.

## 🚀 Quick Start

### Prerequisites

- Docker and Docker Compose
- Modern web browser (for accessing renderers)
- curl (for testing)

### Installation

1. **Clone the repository:**

   ```bash
   git clone <repository-url>
   cd daemon
   ```

2. **Build images (optional first run clean build):**

```bash
docker compose build --no-cache
```

3. **Start services (choose ONE daemon):**

Rust daemon stack:

```bash
docker compose up -d registry rust-daemon react-renderer
```

Node daemon stack:

```bash
docker compose up -d registry node-daemon react-renderer
```

> Both daemons bind port 3001. Do NOT run them simultaneously unless you change one to a different host port.

Optional renderers / html:

```bash
docker compose up -d html-renderer
```

4. **Verify:**

```bash
curl http://localhost:4000/   # registry
curl http://localhost:3001/   # active daemon (rust OR node)
```

Open http://localhost:3000 for the React renderer.

5. **Switching daemons:**

```bash
docker compose stop rust-daemon
# or docker compose stop node-daemon
# then start the other
```

### Verifying the System

After starting a stack:

```bash
docker compose ps
docker compose logs -f rust-daemon   # or node-daemon
```

Look for WebSocket handshake sequence:
`connection_init` → `connection_ack` → `subscribe` → `next` frames.

You should see:

- ✅ Registry: Service ready on port 4000
- ✅ Rust Daemon: Connected to registry
- ✅ Node Daemon: Connected to registry
- ✅ React Renderer: WebSocket connection established
- ✅ HTML Renderer: Server running

## 🧪 Testing the System

### Basic Component Rendering

Send a card component:

```bash
curl -X POST http://localhost:4000/render \
  -H "Content-Type: application/json" \
  -d '{
    "type": "CARD",
    "data": {
      "title": "Hello World! 👋",
      "content": "This component traveled: Registry → Daemon → Renderer",
      "buttons": [
        {"text": "Awesome! 🎉"},
        {"text": "Send Another ✨"}
      ]
    }
  }'
```

### Notification Component

Send a success notification:

```bash
curl -X POST http://localhost:4000/render \
  -H "Content-Type: application/json" \
  -d '{
    "type": "NOTIFICATION",
    "data": {
      "type": "SUCCESS",
      "title": "System Working! ✅",
      "message": "Your GraphQL component flow is operational!"
    }
  }'
```

### Form Component

Send a dynamic form:

```bash
curl -X POST http://localhost:4000/render \
  -H "Content-Type: application/json" \
  -d '{
    "type": "FORM",
    "data": {
      "title": "Contact Form 📝",
      "fields": [
        {"name": "name", "label": "Your Name", "type": "text"},
        {"name": "email", "label": "Email Address", "type": "email"},
        {"name": "message", "label": "Message", "type": "text"}
      ],
      "submitText": "Send Message 🚀"
    }
  }'
```

### Error Notification

Send an error notification:

```bash
curl -X POST http://localhost:4000/render \
  -H "Content-Type: application/json" \
  -d '{
    "type": "NOTIFICATION",
    "data": {
      "type": "ERROR",
      "title": "Oops! ❌",
      "message": "Something went wrong, but the system is still working!"
    }
  }'
```

### Submitting an Action (Trigger Rules)

After creating a FORM component you can simulate a user SUBMIT action to trigger registry rules (which generate a CARD component from the submitted data).

1. List current components and locate the FORM component id:

```bash
curl -s -X POST http://localhost:4000/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"query { components { id type } }"}' | jq -r '.data.components[] | select(.type=="FORM") | .id'
```

2. Export the id (replace with the value you saw):

```bash
FORM_ID="<form-id-here>"
```

3. Send the SUBMIT action to the Rust daemon (which forwards via handleMessage mutation to the registry):

```bash
curl -X POST http://localhost:3001/graphql \
  -H 'Content-Type: application/json' \
  -d "{\"query\":\"mutation($m:String!){sendMessage(message:$m)}\",\"variables\":{\"m\":\"{\\\"direction\\\":\\\"ACTION\\\",\\\"payload\\\":{\\\"id\\\":\\\"action-$(date +%s)\\\",\\\"componentId\\\":\\\"$FORM_ID\\\",\\\"actionType\\\":\\\"SUBMIT\\\",\\\"data\\\":{\\\"name\\\":\\\"Alice\\\",\\\"email\\\":\\\"alice@example.com\\\",\\\"message\\\":\\\"Hello Registry!\\\"},\\\"timestamp\\\":\\\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\\\"},\\\"metadata\\\":{\\\"acknowledged\\\":false,\\\"correlationId\\\":\\\"manual-test\\\",\\\"error\\\":null}}\"}}"
```

4. Watch logs (separate terminals):

```bash
# Registry rule evaluation & component generation
docker compose logs -f registry | egrep 'Registry: (Handling message|Processing action|Evaluating rules|Rule|Publishing new component|No rules triggered)'

# Daemon action flow & mutation forwarding
docker compose logs -f rust-daemon | egrep 'Received ACTION|Mutation WS|Sending handleMessage'
```

Expected sequence:

- Daemon logs: Received ACTION, Mutation WS connected, mutation sent, received complete (or close after result)
- Registry logs: Handling message, Processing action, Evaluating rules, Rule 'form-submit' triggered, Publishing new component
- Renderer displays new CARD component containing submitted data

Troubleshooting:

- If no rule triggers: ensure FORM_ID matches an active FORM component
- If registry shows no handleMessage lines: confirm daemon action curl succeeded and daemon container is running
- If WS closes with code 1006 before mutation: check that mutation braces are single ( `mutation handleMessage($message: String!) { handleMessage ... }` )

## 🏛️ Component Types

### CARD

Interactive card component with title, content, and buttons.

**Structure:**

```json
{
  "type": "CARD",
  "data": {
    "title": "Card Title",
    "content": "Card description text",
    "buttons": [{ "text": "Button Text", "action": "ACTION_NAME" }]
  }
}
```

### NOTIFICATION

Status messages with different types and styling.

**Structure:**

```json
{
  "type": "NOTIFICATION",
  "data": {
    "type": "SUCCESS|ERROR|WARNING|INFO",
    "title": "Notification Title",
    "message": "Notification message",
    "dismissible": true,
    "autoRemove": 5000
  }
}
```

### FORM

Dynamic forms with configurable fields.

**Structure:**

```json
{
  "type": "FORM",
  "data": {
    "title": "Form Title",
    "fields": [
      {
        "name": "fieldName",
        "label": "Field Label",
        "type": "text|email|password",
        "placeholder": "Placeholder text"
      }
    ],
    "submitText": "Submit Button Text"
  }
}
```

## 🔧 Architecture Deep Dive

### Service Roles

1. **Registry (`registry/simple-registry.js`)**

   - Node.js service managing component lifecycle
   - GraphQL subscriptions for real-time updates
   - REST API for component creation
   - In-memory component management
   - Runs in Docker container on port 4000

2. **Rust Daemon (`daemon/rust/component-daemon/src/main.rs`)**

   - High-performance component processor
   - Written in Rust using Warp and async-graphql
   - Subscribes to registry updates
   - Routes components to renderers
   - Runs in Docker container on port 3001

3. **Node Daemon (`daemon/simple-daemon.js`)**

   - Alternative daemon implementation in Node.js
   - Same functionality as Rust daemon
   - Demonstrates technology flexibility
   - Runs in Docker container on port 3001

4. **React Renderer (`renderer/frontend`)**

   - Dynamic component rendering
   - Real-time updates via WebSocket
   - Modern UI with animations
   - Runs in Docker container on port 3000

5. **HTML Renderer (`renderer/html`)**
   - Static HTML rendering alternative
   - Lightweight deployment option
   - Basic component display
   - Runs in Docker container on port 8081

**Key Features:**

- `POST /render` - Create and publish components
- GraphQL subscription `componentUpdate` - Real-time component stream
- Auto-cleanup and TTL support

### Component Daemon (`simple-daemon.js`)

**Purpose**: Middleware that bridges registry and frontend

- **Registry Client**: Subscribes to registry component updates
- **Frontend Server**: Provides GraphQL API for frontend clients
- **Message Forwarding**: Relays components from registry to frontend
- **Connection Management**: Handles reconnections and error recovery

**Key Features:**

- WebSocket connection to registry GraphQL API
- GraphQL subscription server for frontend clients
- Real-time message forwarding
- Health monitoring and reconnection logic

### Frontend Renderer (React App)

**Purpose**: Pure UI rendering system

- **GraphQL Client**: Connects to daemon via WebSocket
- **Component Rendering**: Dynamic UI generation based on component data
- **Real-time Updates**: Live component updates without page refresh
- **Beautiful UI**: Modern glassmorphism design with animations

**Key Features:**

- WebSocket GraphQL subscription client
- Dynamic component type resolution
- Responsive design with animations
- Connection status monitoring

## 🌐 API Reference

### Active Subscription (Renderer ↔ Daemon)

```graphql
subscription {
  messages {
    direction
    kind
    payload
    metadata {
      acknowledged
      correlationId
      error
    }
  }
}
```

### Mutation (Send a Message)

```graphql
mutation SendMessage($m: String!) {
  sendMessage(message: $m)
}
```

`$m` is a JSON string of the envelope (ACTION or COMPONENT) matching the daemon schema.

### Example ACTION Envelope

```json
{
  "direction": "ACTION",
  "payload": {
    "id": "action-1734469900000",
    "componentId": "<component-id>",
    "actionType": "CLICK",
    "data": { "foo": "bar" },
    "timestamp": "2025-08-16T12:34:56.000Z"
  },
  "metadata": {
    "acknowledged": false,
    "correlationId": "action-1734469900000",
    "error": null
  }
}
```

(Older docs showing `message { ... }` or extra fields like `origin/target/timestamp` at top level are deprecated.)

## 🔍 Troubleshooting (Updated)

| Symptom                        | Cause                                           | Fix                                                                  |
| ------------------------------ | ----------------------------------------------- | -------------------------------------------------------------------- |
| WS close code 1006 immediately | Protocol mismatch or both daemons bound to 3001 | Ensure only one daemon; client subprotocol is `graphql-transport-ws` |
| No `connection_ack`            | Registry/daemon not listening or network issue  | Check container logs, port 3001 open                                 |
| ACTION_ECHO missing            | Component id unknown to daemon                  | Ensure component exists before sending action                        |
| STATE_SNAPSHOT missing         | Action for unknown component                    | Same as above; create component first                                |
| Duplicate components           | Rapid rule re-fires / repeated actions          | Add client-side de-duplication (id set)                              |
| No rule trigger                | Rule predicate false                            | Check actionType & component.type match rule expectations            |

## ✨ Key Features

- **🔄 Real-time Component Delivery**: Components appear instantly via GraphQL subscriptions
- **🎨 Dynamic UI Generation**: Backend services can create UI components on-demand
- **🔧 Middleware Architecture**: Clean separation between backend and frontend
- **📱 Technology Agnostic**: Backend can be any language, frontend can be any framework
- **🚀 Scalable**: Multiple daemons and frontends can connect to same registry
- **💫 Beautiful UI**: Modern glassmorphism design with animations
- **Unified WebSocket protocol**: `graphql-transport-ws` across Registry, Daemons, Renderer.
