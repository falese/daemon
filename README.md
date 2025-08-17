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

## ✨ Key Features

- **🔄 Real-time Component Delivery**: Components appear instantly via GraphQL subscriptions
- **🎨 Dynamic UI Generation**: Backend services can create UI components on-demand
- **🔧 Middleware Architecture**: Clean separation between backend and frontend
- **📱 Technology Agnostic**: Backend can be any language, frontend can be any framework
- **🚀 Scalable**: Multiple daemons and frontends can connect to same registry
- **💫 Beautiful UI**: Modern glassmorphism design with animations

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

2. **Start services using Make:**

   ```bash
   # Build all images
   make build

   # Start everything at once
   make all

   # OR use interactive stack launcher
   make stack  # Guides you through daemon and renderer selection
   ```

The `make stack` command provides an interactive way to choose:

- Which daemon to run (Rust or Node.js)
- Which renderer to use (React or HTML)

Individual commands are also available:

- `make rust-daemon` - Start the Rust daemon
- `make node-daemon` - Start the Node.js daemon
- `make react-renderer` - Start the React frontend
- `make html-renderer` - Start the HTML renderer

This will start the selected services:

- Registry (Node.js) on port 4000
- Rust Daemon on port 3001 (if selected)
- Node Daemon on port 3002 (if selected)
- React Renderer on port 3000 (if selected)
- HTML Renderer on port 8081 (if selected)

### Verifying the System

After starting the services with Docker Compose, verify each component:

1. **Check service status:**

   ```bash
   docker-compose ps
   ```

   All services should show as "Up"

2. **Check component health:**

   - Registry: Visit http://localhost:4000
   - Rust Daemon: Visit http://localhost:3001
   - React Renderer: Visit http://localhost:3000
   - HTML Renderer: Visit http://localhost:8081

3. **View service logs:**
   ```bash
   docker-compose logs -f
   ```

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
   - Runs in Docker container on port 3002

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

### Registry REST API

#### Render Component

```http
POST http://localhost:4000/render
Content-Type: application/json

{
  "type": "CARD|NOTIFICATION|FORM",
  "data": { /* component data */ }
}
```

#### Health Check

```http
GET http://localhost:4000/
```

### Bidirectional GraphQL Communication

#### Subscribe to Message Stream

```graphql
subscription {
  message {
    direction: "COMPONENT" | "ACTION"
    payload: {
      id: ID!
      type: String!
      data: JSON!
      timestamp: Int!
      origin: String  # "REGISTRY" | "DAEMON" | "RENDERER"
      target: String  # "REGISTRY" | "DAEMON" | "RENDERER"
    }
    metadata: {
      acknowledged: Boolean
      correlationId: String
      error: String
    }
  }
}
```

#### Message Types

1. **Component Message**

```json
{
  "direction": "COMPONENT",
  "payload": {
    "id": "card-123",
    "type": "CARD",
    "data": {
      "title": "Example Card",
      "content": "Card content"
    },
    "timestamp": 1628509843,
    "origin": "REGISTRY",
    "target": "RENDERER"
  }
}
```

2. **Action Message**

```json
{
  "direction": "ACTION",
  "payload": {
    "id": "action-456",
    "type": "BUTTON_CLICK",
    "data": {
      "componentId": "card-123",
      "buttonId": "submit"
    },
    "timestamp": 1628509844,
    "origin": "RENDERER",
    "target": "DAEMON"
  }
}
```

### State Management

#### Daemon State Structure

```typescript
interface DaemonState {
  components: {
    [componentId: string]: {
      type: string;
      data: any;
      actions: Action[];
      timestamp: number;
    };
  };
  globalState: {
    [key: string]: any;
  };
}
```

#### Registry Rules Engine

Rules in the registry determine what components to generate based on daemon state:

```javascript
// Example rule in registry
const rules = {
  BUTTON_CLICK: (state, action) => {
    if (action.data.buttonId === "submit") {
      return {
        type: "NOTIFICATION",
        data: {
          type: "SUCCESS",
          title: "Form Submitted",
          message: "Your form has been processed",
        },
      };
    }
  },
};
```

#### Bidirectional Communication Example

1. **React Renderer Setup:**

```javascript
// In React renderer
const MessageContext = createContext();

function MessageProvider({ children }) {
  const client = useRef();
  const [subscription, setSubscription] = useState();

  useEffect(() => {
    // Setup WebSocket subscription
    const sub = client.current
      .subscribe({
        query: MESSAGE_SUBSCRIPTION,
        variables: { origin: "RENDERER" },
      })
      .subscribe(({ data }) => {
        const { direction, payload } = data.message;
        if (direction === "COMPONENT") {
          handleNewComponent(payload);
        }
      });

    setSubscription(sub);
    return () => sub.unsubscribe();
  }, []);

  const sendAction = (action) => {
    subscription.next({
      direction: "ACTION",
      payload: {
        ...action,
        timestamp: Date.now(),
        origin: "RENDERER",
        target: "DAEMON",
      },
    });
  };

  return (
    <MessageContext.Provider value={{ sendAction }}>
      {children}
    </MessageContext.Provider>
  );
}
```

2. **Rust Daemon Handling:**

```rust
// In Rust daemon
#[derive(async_graphql::SimpleObject)]
struct Message {
    direction: String,
    payload: Json,
    metadata: Option<Json>,
}

struct MessageStream;

#[Subscription]
impl MessageStream {
    async fn message(
        &self,
        ctx: &Context<'_>,
    ) -> impl Stream<Item = Message> {
        let (tx, rx) = channel(100);

        // Handle incoming messages
        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                match msg.direction.as_str() {
                    "ACTION" => handle_action(msg.payload).await,
                    "COMPONENT" => forward_to_renderer(msg.payload).await,
                    _ => log::warn!("Unknown message type")
                }
            }
        });

        rx
    }
}
```

3. **Registry Rules Processing:**

```javascript
// In registry
const processMessage = async (message) => {
  if (message.direction === "ACTION") {
    const state = await daemon.getState();
    const rule = rules[message.payload.type];

    if (rule) {
      const component = rule(state, message.payload);
      if (component) {
        subscription.next({
          direction: "COMPONENT",
          payload: {
            ...component,
            timestamp: Date.now(),
            origin: "REGISTRY",
            target: "RENDERER",
          },
        });
      }
    }
  }
};
```

## 🎨 Customization

### Adding New Component Types

1. **Update Registry Schema** (`simple-registry.js`):

```javascript
enum ComponentType {
  CARD
  NOTIFICATION
  FORM
  TABLE        // Add new type
}
```

2. **Add Renderer** (React App):

```javascript
const UIRenderers = {
  // ... existing renderers
  TABLE: ({ data }) => (
    <div className="component-card">{/* Your table implementation */}</div>
  ),
};
```

## 🔍 Troubleshooting

### Common Issues

**Registry not publishing components:**

- Run `make logs` and check registry output
- Verify registry service is up with `docker-compose ps`
- If needed, restart registry:
  ```bash
  docker-compose stop registry
  make up  # Restarts registry
  ```

**Daemon not receiving components:**

- Verify WebSocket connection to registry
- Check GraphQL subscription
