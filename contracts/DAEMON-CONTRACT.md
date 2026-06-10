# Daemon Service Contract

This document explains the two-layer class hierarchy that every control-plane
daemon is built on, why each layer exists, and what you are expected to implement
versus what you get for free.

---

## The two layers

```
DaemonService   (abstract — contracts/DaemonService.ts)
    └── YourDaemon  (concrete — NodeDaemon, RustDaemon, EmbeddedMfeDaemon, …)
```

The split is deliberate: the control plane protocol logic lives in
`DaemonService`; the runtime environment (WebSocket library, broadcast
mechanism, server framework) lives in your concrete class.

---

## Layer 1 — `DaemonService` (abstract)

`DaemonService` defines **what every daemon must be able to do**, regardless
of whether it runs in Node.js, Rust, a browser SharedWorker, or as an embedded
process inside a micro-frontend.

It owns:

- **Message routing** — dispatches incoming envelopes by `direction`
  (ACTION → upward pipeline, COMPONENT → downward pipeline)
- **The 5-step action pipeline** — the fixed sequence every daemon must execute
  when a renderer submits an action (normalise → record → echo → snapshot → forward)
- **Component state cache** — `Map<componentId, ComponentState>` with correct
  upsert semantics (preserves action history on update)
- **Reconnect backoff** — bounded exponential backoff formula identical to both
  the Node.js and Rust implementations
- **Action normalisation** — BUTTON_CLICK → CLICK mapping (browser DOM leak)
- **Message envelope construction** — consistent metadata defaults for every
  outbound message

`DaemonService` implements **none** of the environment-specific operations. The
abstract methods are listed below — TypeScript will error if a subclass misses any.

```typescript
// DaemonService declares what must exist…
abstract start(): Promise<void>;
abstract stop(): Promise<void>;
protected abstract connectToRegistry(): void;
abstract onRendererMessage(envelope: Message): Promise<Message | null>;
protected abstract publish(message: Message): void;
protected abstract forwardActionToRegistry(envelope: Message): Promise<void>;
```

This design means the same protocol logic works for TypeScript (Node.js,
browser), Rust, Go, Python — each language provides its own concrete class,
all satisfying the same method surface.

---

## Layer 2 — Your concrete daemon

Your class `extends DaemonService` and satisfies the abstract contract for a
specific runtime environment.

### What you must implement

| Abstract method | What your implementation does |
|---|---|
| `start()` | Wire up the registry subscription + renderer server, then call `this.connectToRegistry()` |
| `stop()` | Set `this.stopping = true`, close all sockets, drain subscriptions |
| `connectToRegistry()` | Open a persistent `graphql-transport-ws` WebSocket to the Registry; call `handleComponentFromRegistry()` on `next` frames; schedule reconnect via `reconnectDelayMs()` on close |
| `onRendererMessage(envelope)` | GraphQL resolver body for `sendMessage` mutation — call `return this.handleMessage(envelope)` |
| `publish(message)` | Fan out to all connected renderer subscriptions (PubSub, broadcast channel, postMessage, …) |
| `forwardActionToRegistry(envelope)` | Open a short-lived WebSocket to the Registry and call the `handleMessage(message: String!)` mutation; timeout at `this.forwardTimeoutMs` |

### What you get for free

| Concrete method | What it does |
|---|---|
| `handleMessage(envelope)` | Routes by `direction`: ACTION → `handleAction`, COMPONENT → `handleInboundComponent` |
| `handleAction(envelope)` | Runs the full 5-step pipeline (see below) |
| `handleInboundComponent(envelope)` | Stores component + broadcasts COMPONENT_UPDATE |
| `handleComponentFromRegistry(component)` | Stores component + broadcasts COMPONENT_UPDATE (called from `connectToRegistry`) |
| `storeComponent(component)` | Upserts into the state cache, preserving action history |
| `getComponents()` | Returns all cached components (for the `components` query resolver) |
| `getComponentStates()` | Returns all component states (for the `componentStates` query resolver) |
| `reconnectDelayMs(attempt)` | `min(reconnectMaxMs, reconnectBaseMs * reconnectFactor ^ attempt)` |
| `normalizeActionType(action)` | BUTTON_CLICK → CLICK; preserves original in `data.originalActionType` |
| `buildMessage(parts)` | Constructs a `Message` with consistent metadata defaults |
| `generateId()` | `crypto.randomUUID()` — override if your target lacks it |
| `onForwardError(id, err)` | No-op hook — override to add logging or metrics |

### Minimal skeleton

```typescript
import { DaemonService, type Message, type DaemonConfig } from '@control-plane/contracts';

export class MyDaemon extends DaemonService {
  constructor(config: DaemonConfig) {
    super(config);
  }

  // ── Required — TypeScript errors if any of these are missing ──

  async start(): Promise<void> {
    this.connectToRegistry();
    // start your GraphQL/WebSocket server here
  }

  async stop(): Promise<void> {
    this.stopping = true;   // ← MUST be first; guards reconnect timers
    // close sockets, drain subscriptions
  }

  protected connectToRegistry(): void {
    if (this.stopping) return;

    const ws = new WebSocket(this.registryUrl, 'graphql-transport-ws');

    ws.onopen = () => {
      this.registryReconnectAttempt = 0;   // ← reset counter on success
      ws.send(JSON.stringify({ type: 'connection_init' }));
    };

    ws.onmessage = (evt) => {
      const frame = JSON.parse(evt.data as string);
      if (frame.type === 'connection_ack') {
        ws.send(JSON.stringify({
          id: '1', type: 'subscribe',
          payload: { query: 'subscription { componentUpdate { id type data createdAt } }' },
        }));
      }
      if (frame.type === 'next') {
        const component = frame.payload?.data?.componentUpdate;
        if (component) this.handleComponentFromRegistry(component);
      }
    };

    ws.onclose = () => {
      if (this.stopping) return;
      const delay = this.reconnectDelayMs(this.registryReconnectAttempt++);
      setTimeout(() => this.connectToRegistry(), delay);
    };
  }

  async onRendererMessage(envelope: Message): Promise<Message | null> {
    return this.handleMessage(envelope);  // route to the concrete pipeline
  }

  protected publish(message: Message): void {
    // Fan out to your subscribers.
    // Node example:  this.pubsub.publish('MESSAGES', { messages: message });
    // Browser example: this.listeners.forEach(cb => cb(message));
  }

  protected async forwardActionToRegistry(envelope: Message): Promise<void> {
    // Open a short-lived WS, wait for connection_ack, send handleMessage mutation.
    // Abort if no response within this.forwardTimeoutMs.
  }

  // ── Optional overrides ─────────────────────────────────────

  protected onForwardError(actionId: string, error: unknown): void {
    console.error(`[DAEMON] ACTION_FORWARD_ERROR id=${actionId}`, error);
  }
}
```

---

## The action pipeline

Every action from a renderer passes through the 5-step pipeline in
`DaemonService.handleAction()`. The steps are fixed and the order is a
protocol invariant.

```
Renderer                     DaemonService.handleAction()             Registry
  |                               |                                      |
  | sendMessage(ACTION envelope)  |                                      |
  | ─────────────────────────────►|                                      |
  |                               | Step 1: normaliseActionType()        |
  |                               | Step 2: storeComponent / push action |
  |                               | Step 3: publish ACTION_ECHO ─────────┐
  | ◄── ACTION_ECHO ──────────────|                                      │ (echo)
  |                               | Step 4: publish STATE_SNAPSHOT ──────┐
  | ◄── STATE_SNAPSHOT ───────────|                                      │ (snapshot)
  |                               | Step 5: forwardActionToRegistry() ──►|
  |                               |         (fire-and-forget; no await)  |
  |                               |                                      | rules fire
  |                               |                                      | publish componentUpdate
  |                               |◄──── subscription next ─────────────|
  |                               | handleComponentFromRegistry()        |
  | ◄── COMPONENT_UPDATE ─────────|                                      |
```

**Why echo before snapshot?**
The renderer uses the `correlationId` in the echo to match the snapshot.
If the snapshot arrived first, the renderer would see it as an unmatched event.

**Why both before forward?**
By the time the registry fires a rule and a new component arrives, the renderer
has already acknowledged the action and received the current state. There is no
"update before ack" race.

**Why fire-and-forget on the forward?**
The renderer has already received the echo and snapshot by the time `forwardActionToRegistry`
is called. Blocking on the registry response would add latency to the
renderer acknowledgement path without benefit to the user. If the forward
fails, `onForwardError()` is called so the failure can be observed without
propagating to the renderer.

---

## The resolution pipeline (ADR-054 / PLATFORM-CONTRACT v3.2)

The wire protocol is now defined once in `@seans-mfe/contracts` (the
seans-mfe-tool platform contracts package, consumed here as a vendored
tarball — see `vendor/`) and re-exported by this package. On top of the
action pipeline, `DaemonService` implements the **resolution pipeline**:
the registry no longer only generates fixed components — it can answer a
state change with a *resolution* `{ mfe, capability, props }`, and the
daemon drives the resolved MFE's platform capabilities.

During migration, canonical payloads ride the legacy component envelope:

| Component `type` | `data` payload | Meaning |
|---|---|---|
| `RESOLUTION` | `Resolution` + `sessionId?`, `correlationId?` | Registry chose an MFE for the current state |
| `EXPERIENCE` | `RenderedExperience` | What the resolved MFE's `render()` produced |
| `RESOLUTION_ERROR` | `{ mfe, capability, reason }` | The daemon could not fulfil a resolution |

`DaemonService.handleResolution()` is concrete — the order is a protocol
invariant:

```
Registry                      DaemonService                          MFE
  | componentUpdate            |                                      |
  | (type: RESOLUTION) ───────►| Step 1: mfeDirectory.lookup(mfe)     |
  |                            | Step 2: invoker.authorizeAccess() ──►| /authorize (JWT)
  |                            | Step 3: invoker.load()  [once] ─────►| /load
  |                            | Step 4: invoker.render() ───────────►| /render (capability, props)
  |                            |   — or refresh() when the same       |
  |                            |     MFE+capability is already        |
  |                            |     active for this session          |
  |                            | Step 5: publish COMPONENT_UPDATE     |
  |                            |   (type: EXPERIENCE, the MFE's       |
  |                            |    RenderedExperience)               |
```

**Sessions and user context.** Actions may carry a `context: SessionContext`
(sessionId, user, jwt, application, locale). The daemon caches it
(`sessions` map) and the registry threads the `sessionId` back on each
resolution, so the daemon invokes the MFE *for that user, in that
application* — the same state change can resolve different experiences for
different users. Render-vs-refresh is decided per session.

**Collaborators.** `MfeDirectory` (where does the resolved MFE live —
default `StaticMfeDirectory`, seeded from `DaemonServiceConfig.mfes`) and
`MfeInvoker` (how its capabilities are called — default `HttpMfeInvoker`,
which POSTs to the standard `/authorize` `/load` `/render` `/refresh`
endpoints of an SMT-generated MFE). Both are injectable for tests and for
non-HTTP delivery mechanisms.

Run the contract tests with `make contracts-test`
(`contracts/__tests__/daemon-service.test.js`).

---

## Connection to the MFE

The MFE framework (`@seans-mfe-tool/runtime`) connects to this control plane
through `RemoteMFE.doUpdateControlPlaneState()`. Here is the full call path:

```
YourMFE.DataAnalysis()
  │
  └── this.updateControlPlaneState(context.clone({
        inputs: { stateKey: 'analysis.complete', stateData: { ... }, correlationId }
      }))
        │
        └── RemoteMFE.doUpdateControlPlaneState(context)
              │   builds ACTION envelope:
              │   { direction: 'ACTION', kind: 'ACTION',
              │     payload: { actionType: stateKey, data: stateData, ... },
              │     metadata: { correlationId, acknowledged: false, error: null } }
              │
              └── sendMessage mutation (graphql-transport-ws → daemon :3001)
                    │
                    └── DaemonService.onRendererMessage(envelope)
                          │
                          └── DaemonService.handleMessage(envelope)
                                │
                                └── DaemonService.handleAction(envelope)
                                      │  (5-step pipeline runs)
                                      │
                                      ├── publish ACTION_ECHO ──────────────────────┐
                                      │                                              │ returned to
                                      └── forwardActionToRegistry()                 │ MFE as
                                            │                                        │ ControlPlaneStateResult
                                            └── Registry.handleMessage()            │
                                                  └── rules engine fires            │
                                                        └── publish componentUpdate │
                                                              └── renderer sees     │
                                                                  COMPONENT_UPDATE  │
                                                                                    ▼
                                                              ControlPlaneStateResult {
                                                                acknowledged: true,
                                                                correlationId: "...",
                                                                error: null
                                                              }
```

The `ControlPlaneStateResult` the MFE receives maps directly to the
`ACTION_ECHO` metadata:

| `ControlPlaneStateResult` field | Source |
|---|---|
| `acknowledged` | `ACTION_ECHO.metadata.acknowledged` (always `true`) |
| `correlationId` | `ACTION_ECHO.metadata.correlationId` (echoed from the request) |
| `error` | `ACTION_ECHO.metadata.error` (`null` on success) |

---

## Why separation of concerns matters

| Layer | Owns | Does not own |
|---|---|---|
| `DaemonService` | Protocol logic, pipeline, state cache, backoff math | WebSocket library, server framework, broadcast mechanism |
| `YourDaemon` | Runtime wiring (sockets, pub/sub, server) | Protocol logic |

### Testability

`DaemonService` can be tested with a stub implementation that overrides
`publish` to capture messages and `forwardActionToRegistry` to resolve
immediately — no real WebSocket needed. The 5-step pipeline, backoff
formula, and normalisation are all unit-testable in isolation.

### Language portability

`DaemonService` expresses the contract in TypeScript. The same contract is
described in `SPEC.md` for implementers in other languages. The Node.js and
Rust daemons both implement this contract today (without inheriting it, since
Rust has no JS class hierarchy) and their behaviour is verified to be identical
through the integration tests.

---

## Quick reference

```
Question                                                   Answer
─────────────────────────────────────────────────────────  ───────────────────────────────────────────────
Where is the 5-step action pipeline?                       DaemonService.handleAction()
Where does reconnect backoff live?                         DaemonService.reconnectDelayMs()
Where does BUTTON_CLICK normalisation happen?              DaemonService.normalizeActionType()
Where do I put WebSocket open/close logic?                 connectToRegistry() in your concrete class
Where do I put GraphQL server setup?                       start() in your concrete class
Where do I fan out to renderer subscribers?                publish() in your concrete class
Can I skip calling super() in the constructor?             No — reconnect constants are set there
Can I override handleAction() directly?                    Strongly discouraged; override onForwardError()
                                                           if you only need error observability
Why is forwardActionToRegistry() fire-and-forget?          Renderer already has echo+snapshot; blocking
                                                           adds latency without benefit to the user
How does updateControlPlaneState() reach the registry?     See "Connection to the MFE" above
What does ControlPlaneStateResult map to?                  The ACTION_ECHO.metadata fields
```

---

## Related files

| File | Purpose |
|---|---|
| `contracts/types.ts` | All shared interfaces (Component, ActionRecord, Message, etc.) |
| `contracts/DaemonService.ts` | Abstract base class |
| `contracts/index.ts` | Public exports for `@control-plane/contracts` |
| `component-system/daemon/simple-daemon.js` | Node.js concrete implementation |
| `component-system/daemon/rust/component-daemon/src/main.rs` | Rust concrete implementation |
| `component-system/registry/simple-registry.js` | Registry rules engine (receives forwarded actions) |
| `SPEC.md` | Full protocol specification (language-neutral) |
