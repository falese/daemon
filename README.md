# Control Plane Daemon — Teaching Demo

A minimal working example of a control plane: a daemon watches UI actions, routes them through a rules engine, and pushes back components to render.

> See [SPEC.md](./SPEC.md) for the full protocol specification.

---

## Quick Start

```bash
make build        # build all Docker images
make all          # start the registry
make stack        # interactively choose a daemon + renderer
```

Then open one of the renderers:

| Renderer | URL | Notes |
|---|---|---|
| React (CSR) | http://localhost:3000 | Create React App, live WebSocket |
| HTML | http://localhost:8081 | Vanilla JS, no build step |
| React (SSR) | http://localhost:3003 | Server-rendered HTML + hydration |

The SSR renderer (`make ssr-renderer`) requires the Node daemon (`make node-daemon`) to be running since it fetches the initial state snapshot over HTTP before streaming the first byte.

---

## What You'll See

Once the stack is running, post a FORM component:

```bash
make form
```

A form appears in the renderer. Submit it (click "Send Message") and watch:
- The action travels from renderer → daemon → registry
- The registry rules engine evaluates the action against registered rules
- The `form-submit` rule fires and generates a CARD component with the submitted data
- The new CARD appears in the renderer — no page refresh needed

This is the core teaching pattern: **renderer sends an action, the rules engine decides what to render next**.

Click the resulting CARD to see slot composition in action:
- The `card-click` rule fires and generates a NOTIFICATION with a `_slot` directive pointing at the CARD's `detail` slot.
- The daemon validates the assignment and broadcasts a `SLOT_ASSIGNMENT` message.
- All renderers move the NOTIFICATION *inside* the CARD rather than appending it below.

See [SLOT-COMPOSITION.md](./SLOT-COMPOSITION.md) for the full design.

---

## Architecture

```
┌─────────────┐  subscription   ┌─────────────┐  subscription   ┌──────────────────────┐
│  Registry   │ ──────────────► │    Daemon   │ ──────────────► │  Renderer            │
│  :4000      │                 │    :3001    │                 │  :3000 / :8081 /     │
│             │ ◄────────────── │             │ ◄────────────── │  :3003               │
│  Rules +    │  handleMessage  │  Middleware │  sendMessage    │  React / HTML / SSR  │
│  State      │  mutation       │  + State    │  mutation       │                      │
└─────────────┘                 └─────────────┘                 └──────────────────────┘
```

All connections use the `graphql-transport-ws` subprotocol over WebSocket. The SSR renderer additionally makes a one-shot HTTP GraphQL request to fetch the initial snapshot before streaming HTML.

### Service Roles

| Service | Role |
|---|---|
| **Registry** (`registry/simple-registry.js`) | Stores component state, runs the rules engine, publishes `componentUpdate` subscriptions, exposes REST `POST /render` |
| **Rust Daemon** (`daemon/rust/component-daemon/src/main.rs`) | High-performance middleware; subscribes to registry, broadcasts to renderers, forwards actions back to registry |
| **Node Daemon** (`daemon/simple-daemon.js`) | Same role as Rust daemon; also owns the slot assignment map and `assignSlot` mutation |
| **React Renderer** (`renderer/frontend`) | CSR; subscribes to daemon, renders CARD / FORM / NOTIFICATION components, sends user actions back via GraphQL mutation |
| **HTML Renderer** (`renderer/html`) | Lightweight alternative renderer; plain HTML + JS, no build step |
| **SSR Renderer** (`renderer/ssr`) | Renders initial HTML on the server using `renderToPipeableStream`, streams it to the browser, then hydrates and subscribes via WebSocket for live updates |

---

## Data Flows

### Component Flow: Registry → Daemon → Renderer

```
Client (curl)       Registry             Daemon               Renderer
  | POST /render --> |                    |                    |
  |                  | store component    |                    |
  |                  | publish sub event  |                    |
  |                  | ── subscription ──►|                    |
  |                  |                    | cache & forward    |
  |                  |                    | ── subscription ──►| render
```

1. A component is created via `POST /render`, a GraphQL mutation, or a rule firing.
2. Registry publishes a `componentUpdate` subscription event.
3. Daemon's persistent subscription receives the event and caches the component state.
4. Daemon broadcasts the component over its own subscription to all connected renderers.
5. Renderer updates the UI.

### Action Flow: Renderer → Daemon → Registry → New Component

```
Renderer          Daemon                    Registry            Daemon (sub)     Renderer
  | sendMessage ──►| cache action           |                   |                |
  |                | open mutation WS ─────►|                   |                |
  |                | connection_init        |                   |                |
  |                | ◄─ connection_ack ─────|                   |                |
  |                | handleMessage ────────►| run rules         |                |
  |                |                        | publish ──────────►sub event ─────►| render
```

1. User interacts with a component (submit form, click button).
2. Renderer sends an ACTION envelope to the daemon via `sendMessage` mutation.
3. Daemon caches the action and opens a short-lived WebSocket to call `handleMessage` on the registry.
   - A separate WS per mutation isolates failures and ensures `graphql-transport-ws` handshake.
4. Registry loads component state, evaluates all registered rules.
5. Matching rules generate new component(s); registry publishes them — Component Flow resumes.

**Action envelope shape:**

```json
{
  "direction": "ACTION",
  "payload": {
    "id": "action-<ts>",
    "componentId": "<component-id>",
    "actionType": "SUBMIT",
    "data": { "name": "Alice", "email": "alice@example.com" },
    "timestamp": "2025-08-16T12:34:56.000Z"
  },
  "metadata": { "acknowledged": false, "correlationId": "...", "error": null }
}
```

### Rules Engine

Rules live in `ComponentRegistry` as a `Map<string, Rule>` where each rule is:

```js
{
  condition: (state, action) => boolean,  // should this rule fire?
  generate:  (state, action) => ComponentSpec  // what component to create?
}
```

Default rules:

| Rule | Condition | Generates |
|---|---|---|
| `card-click` | CARD component + CLICK action | NOTIFICATION slotted into the CARD's `detail` slot |
| `form-submit` | FORM component + SUBMIT action | CARD with `slots: ['detail']` and submitted data |

Run the unit tests to see them in isolation:

```bash
make test
# or: cd component-system/registry && npm test
```

---

## Testing the System

### Post a FORM and trigger rules (the main demo)

```bash
# Step 1: post a FORM component
make form

# Step 2: get the FORM component id
curl -s -X POST http://localhost:4000/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"query { components { id type } }"}' \
  | jq -r '.data.components[] | select(.type=="FORM") | .id'

# Step 3: send a SUBMIT action (replace <id> with the value above)
make action FORM_ID=<id>
```

Or use the `make action` shortcut which builds the full envelope automatically.

### Watch the log sequence

```bash
# Terminal 1 — registry rule evaluation
make rules-logs

# Terminal 2 — all services
make logs
```

Expected log sequence for a SUBMIT action:
1. Daemon: `Received ACTION message`
2. Daemon: `Mutation WS connected for handleMessage`
3. Registry: `Handling message` → `Processing action`
4. Registry: `Evaluating rules` → `Rule 'form-submit' triggered`
5. Registry: `Publishing new component <new-id>`
6. Daemon: `Received component from registry: <new-id>`
7. Renderer: new CARD appears

### Post other component types directly

```bash
# CARD with clickable buttons
curl -X POST http://localhost:4000/render \
  -H "Content-Type: application/json" \
  -d '{"type":"CARD","data":{"title":"Hello","content":"A card component","buttons":[{"text":"Click me"}]}}'

# NOTIFICATION
curl -X POST http://localhost:4000/render \
  -H "Content-Type: application/json" \
  -d '{"type":"NOTIFICATION","data":{"status":"SUCCESS","title":"It works","message":"Component flow is operational"}}'
```

---

## Component Types

### CARD

```json
{
  "type": "CARD",
  "data": {
    "title": "Card Title",
    "content": "Description text",
    "buttons": [{ "text": "Button Label", "action": "ACTION_NAME" }]
  }
}
```

### NOTIFICATION

```json
{
  "type": "NOTIFICATION",
  "data": {
    "status": "SUCCESS | ERROR | WARNING | INFO",
    "title": "Notification Title",
    "message": "Notification message"
  }
}
```

### FORM

```json
{
  "type": "FORM",
  "data": {
    "title": "Form Title",
    "fields": [
      { "name": "fieldName", "label": "Field Label", "type": "text | email | password" }
    ],
    "submitText": "Submit"
  }
}
```

---

## Slot Composition

Components can declare named holes in their layout (`slots: ['detail']`). The daemon owns the authoritative mapping of what fills each slot and broadcasts `SLOT_ASSIGNMENT` messages when an assignment changes. Renderers display whatever the daemon assigned — they never decide the contents themselves.

The built-in demo shows this end-to-end:
1. `make form` → injects a FORM
2. Submit the form → `form-submit` rule creates a CARD with `slots: ['detail']`
3. Click the CARD → `card-click` rule creates a NOTIFICATION with `data._slot = { parentId, slotName: 'detail' }`
4. Daemon validates and maps the slot → broadcasts `SLOT_ASSIGNMENT`
5. NOTIFICATION appears *inside* the CARD's detail section, not in the global list

You can also assign slots directly via GraphQL:

```graphql
mutation {
  assignSlot(parentId: "card-id", slotName: "detail", childId: "notif-id")
}
```

Pass `childId: null` to clear a slot. Full design: [SLOT-COMPOSITION.md](./SLOT-COMPOSITION.md).

---

## SSR Renderer

The SSR renderer at `renderer/ssr` demonstrates streaming server-side rendering alongside the live WebSocket approach:

1. **On each request**, Express fetches the current components and slot assignments from the daemon via HTTP POST `/graphql`.
2. React renders the component tree on the server using `renderToPipeableStream` and streams HTML to the browser immediately (shell first, then component content).
3. `window.__INITIAL_STATE__` and `window.__DAEMON_PORT__` are injected into the HTML head.
4. The client bundle hydrates with `hydrateRoot` using the same initial state — no flash of unstyled or empty content.
5. After hydration, a WebSocket subscription keeps the UI live (same as the CSR renderer).

```
Browser                    SSR Server (3003)        Node Daemon (3002)
  |                              |                        |
  | GET /                        |                        |
  |─────────────────────────────►|                        |
  |                              | POST /graphql          |
  |                              |───────────────────────►|
  |                              |◄── components + slots ─|
  |◄── stream: HTML shell ───────|                        |
  |◄── stream: components ───────|                        |
  |◄── stream: closing tags ─────|                        |
  | hydrateRoot()                |                        |
  |─────────── WS subscribe ─────────────────────────────►|
  |◄─────────────────── live COMPONENT_UPDATE / SLOT_ASSIGNMENT ──|
```

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `REGISTRY_URL` | `ws://registry:4000/graphql` | Registry WebSocket endpoint (daemon config) |
| `COMPONENT_TTL_MS` | `600000` (10 min) | How long the registry keeps a component in memory |
| `LOG_JSON` | unset | Set to `1` for structured JSON logs from the Node daemon |
| `PORT` | `3001` | Daemon HTTP/WS port |
| `DAEMON_HTTP_URL` | `http://localhost:3001/graphql` | HTTP endpoint the SSR server uses to fetch initial state |
| `PUBLIC_DAEMON_PORT` | `3001` | Daemon WebSocket port the browser connects to after hydration |

Both daemons bind to port 3001 inside Docker. The `docker-compose.yml` maps the Rust daemon to host port `3001` and the Node daemon to host port `3002`, so you **can** run both simultaneously — they just serve from different host ports.

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| WS close code 1006 immediately | Protocol mismatch | Confirm client uses `graphql-transport-ws` subprotocol |
| No `connection_ack` from registry | Registry not running or network issue | `make logs-registry`; check port 4000 is reachable |
| Daemon not receiving components | Subscription disconnected | Check daemon logs for reconnect loop; WS 1006 hints at subprotocol mismatch |
| `No rules triggered` in registry logs | Rule condition not matched | Confirm `actionType` string and `component.type` match rule expectations (case-sensitive) |
| Registry shows action but daemon silent | Mutation WS failed | Check daemon logs for `Mutation WS` lines; ensure `connection_ack` was received before mutation |
| Renderer shows no components | Not connected to daemon | Open browser console; look for WebSocket errors on port 3001 |
| Duplicate components in renderer | Rapid re-fires or repeated form posts | Add client-side deduplication by component id |
