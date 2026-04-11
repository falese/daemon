// ============================================================
// CONTROL PLANE — DAEMON SERVICE ABSTRACT BASE CLASS
// ============================================================
//
// WHY this file exists
// ─────────────────────
// The control plane has two daemon implementations today
// (Node.js, Rust) and may gain more (MFE embedded daemon,
// edge worker, browser SharedWorker, …). Without a shared
// contract each implementation drifts: different method names,
// missing steps in the action pipeline, subtly wrong reconnect
// behaviour.
//
// This abstract class is that contract. It:
//   • Forces implementers to provide the parts that are
//     inherently environment-specific — how you open a
//     WebSocket in Node vs a browser vs Rust is not the same.
//   • Provides concrete helpers for logic that is purely
//     algorithmic and therefore identical everywhere: backoff
//     math, message construction, action normalisation, the
//     5-step action pipeline.
//
// The split rule of thumb
// ────────────────────────
//   abstract = "you must supply this, and only you know how"
//   concrete  = "the algorithm is fixed; don't re-implement it"
//
// See DAEMON-CONTRACT.md for the full explainer, sequence
// diagrams, and the connection to RemoteMFE.doUpdateControlPlaneState().
// ============================================================

import {
  Component,
  ActionRecord,
  ComponentState,
  Message,
  MessageDirection,
  MessageKind,
  MessageMetadata,
  DaemonConfig,
} from './types';

// Re-export so consumers only need a single import path.
export type {
  Component,
  ActionRecord,
  ComponentState,
  Message,
  MessageDirection,
  MessageKind,
  MessageMetadata,
  DaemonConfig,
};

// ── Default reconnect constants ──────────────────────────────
// These match the values in simple-daemon.js and main.rs exactly.
// They are module-level so that a future change here is a one-liner.
const DEFAULT_RECONNECT_BASE_MS  = 400;
const DEFAULT_RECONNECT_MAX_MS   = 5_000;
const DEFAULT_RECONNECT_FACTOR   = 1.6;
const DEFAULT_FORWARD_TIMEOUT_MS = 4_000;

// ============================================================
// ABSTRACT BASE CLASS
// ============================================================

export abstract class DaemonService {

  // ── Protected state ──────────────────────────────────────
  // Declared on the base class so:
  //   a) implementations don't forget to declare them, and
  //   b) the concrete helpers (storeComponent, handleAction,
  //      reconnectDelayMs) can use them without casting.

  /** Live component cache: componentId → { component, actions, lastUpdated }. */
  protected componentState: Map<string, ComponentState> = new Map();

  /**
   * How many consecutive registry reconnect attempts have been made.
   * MUST be reset to 0 by the implementation on a successful connect.
   * Used by the concrete `reconnectDelayMs()` helper.
   */
  protected registryReconnectAttempt = 0;

  /**
   * Set to true by `stop()`. Implementations MUST check this flag before
   * scheduling any new reconnect timer so that graceful shutdown doesn't
   * trigger another connection attempt.
   */
  protected stopping = false;

  // ── Read-only config ─────────────────────────────────────
  protected readonly registryUrl: string;
  protected readonly port: number;
  protected readonly reconnectBaseMs: number;
  protected readonly reconnectMaxMs: number;
  protected readonly reconnectFactor: number;
  protected readonly forwardTimeoutMs: number;

  constructor(config: DaemonConfig = {}) {
    this.registryUrl     = config.registryUrl    ?? 'ws://registry:4000/graphql';
    this.port            = config.port           ?? 3001;
    this.reconnectBaseMs = config.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
    this.reconnectMaxMs  = config.reconnectMaxMs  ?? DEFAULT_RECONNECT_MAX_MS;
    this.reconnectFactor = config.reconnectFactor ?? DEFAULT_RECONNECT_FACTOR;
    this.forwardTimeoutMs = config.forwardTimeoutMs ?? DEFAULT_FORWARD_TIMEOUT_MS;
  }

  // ============================================================
  // LIFECYCLE — ABSTRACT
  // These are the entry points the server harness calls.
  // They are abstract because the underlying libraries differ
  // between environments.
  // ============================================================

  /**
   * Start the daemon — establish the registry subscription and begin
   * accepting renderer connections.
   *
   * WHY abstract: Node orchestrates an http.Server + WebSocket upgrade;
   * a browser MFE may use a SharedWorker with no server at all; Rust uses
   * warp + tokio. The orchestration of these resources is not portable.
   *
   * Recommended implementation body:
   *   this.connectToRegistry();
   *   await this.startRendererServer();
   */
  abstract start(): Promise<void>;

  /**
   * Gracefully shut down — close all sockets, drain subscriptions, cancel timers.
   *
   * Implementations MUST set `this.stopping = true` as their first step so
   * that any in-flight reconnect timer does not fire after the daemon is stopped.
   */
  abstract stop(): Promise<void>;

  /**
   * Establish (and maintain) the persistent WebSocket subscription to the
   * Registry's `componentUpdate` subscription.
   *
   * On receiving a `next` frame containing a component, call
   * `this.handleComponentFromRegistry(component)`.
   *
   * On close (non-stopping), schedule the next attempt using
   * `this.reconnectDelayMs(this.registryReconnectAttempt++)`. Reset
   * `registryReconnectAttempt = 0` on a successful `connection_ack`.
   *
   * WHY abstract: the WebSocket constructor differs between Node (`ws`
   * package), Deno, and browsers. Reconnect scheduling also differs
   * (setTimeout vs tokio::time::sleep). The delay *calculation* is
   * concrete — see `reconnectDelayMs()`.
   */
  protected abstract connectToRegistry(): void;

  // ============================================================
  // RENDERER SERVER — ABSTRACT
  // The three operations exposed to renderers. Abstract because
  // how you wire a GraphQL resolver and how you fan out to
  // subscribers are both environment-specific.
  // ============================================================

  /**
   * The `sendMessage(message: String!): Boolean!` mutation resolver body.
   *
   * Callers pass the JSON-parsed envelope. This method should dispatch to
   * `this.handleMessage(envelope)` and return the result.
   *
   * WHY abstract: the GraphQL library wiring (resolvers, schema, context
   * injection) is environment-specific. The application logic lives in
   * `handleMessage` / `handleAction` / `handleInboundComponent`, which
   * are concrete.
   *
   * Recommended implementation body:
   *   return this.handleMessage(envelope);
   */
  abstract onRendererMessage(envelope: Message): Promise<Message | null>;

  /**
   * Publish a message to all connected renderer subscriptions.
   *
   * WHY abstract: Node uses `PubSub.publish()`; Rust uses
   * `broadcast::Sender.send()`; a SharedWorker daemon uses `postMessage()`.
   * The fan-out mechanism is inseparable from the runtime environment.
   */
  protected abstract publish(message: Message): void;

  // ============================================================
  // FORWARD — ABSTRACT
  // ============================================================

  /**
   * Open a short-lived `graphql-transport-ws` connection to the Registry
   * and send the `handleMessage(message: String!)` mutation.
   *
   * WHY a separate connection per action (rather than reusing the persistent
   * subscription socket): the `graphql-transport-ws` spec allows queries and
   * mutations over the same session, but reusing the subscription socket
   * couples action success/failure to the subscription lifecycle. A separate
   * socket isolates failures — if the mutation times out, the subscription
   * is unaffected. See DAEMON-CONTRACT.md § "Why fire-and-forget?" for more.
   *
   * WHY abstract: opening a WebSocket with a timeout is runtime-specific.
   * Implementations MUST respect `this.forwardTimeoutMs` as the deadline.
   * On failure, call `this.onForwardError(actionId, error)`.
   */
  protected abstract forwardActionToRegistry(envelope: Message): Promise<void>;

  // ============================================================
  // MESSAGE DISPATCH — CONCRETE
  // The routing rule is universal: direction decides the handler.
  // Making it concrete prevents implementations from accidentally
  // swapping the two branches or adding a third unconditionally.
  // ============================================================

  /**
   * Route an incoming message envelope to the correct handler based on
   * `envelope.direction`. This is the single dispatch point — do not bypass it.
   *
   *   ACTION    → handleAction    (up: renderer → registry)
   *   COMPONENT → handleInboundComponent (down: registry → renderer via daemon)
   *
   * WHY concrete: the routing rule is invariant. Making it abstract would
   * invite divergence between implementations.
   */
  async handleMessage(envelope: Message): Promise<Message | null> {
    if (!envelope || typeof envelope !== 'object') return null;
    if (envelope.direction === 'ACTION')    return this.handleAction(envelope);
    if (envelope.direction === 'COMPONENT') return this.handleInboundComponent(envelope);
    return null;
  }

  // ============================================================
  // ACTION PIPELINE — CONCRETE
  // The 5-step pipeline is identical in both existing impls.
  // Making it concrete eliminates the class of bugs where an
  // implementer forgets step 3 (echo) or step 4 (snapshot) and
  // renderers silently lose acknowledgement.
  // ============================================================

  /**
   * Process an ACTION message from a renderer (the upward path).
   *
   * The five steps must always execute in this order:
   *
   *   Step 1 — Normalise:  BUTTON_CLICK → CLICK (browser DOM events leak in)
   *   Step 2 — Record:     append action to per-component action history
   *   Step 3 — Echo:       publish ACTION_ECHO so renderer knows daemon got it
   *   Step 4 — Snapshot:   publish STATE_SNAPSHOT so renderer gets current state
   *   Step 5 — Forward:    fire-and-forget mutation to Registry (do NOT await)
   *
   * Step ordering matters:
   *   • Echo before snapshot: the renderer uses the correlationId in the echo
   *     to match the snapshot. If snapshot arrived first, the renderer would
   *     see it as an unmatched event.
   *   • Both before forward: by the time the registry fires a rule and a new
   *     component arrives at the renderer, the renderer has already acknowledged
   *     the action and has the current state. There is no "update before ack" race.
   *
   * WHY concrete: all five steps are load-bearing and the order is a protocol
   * invariant. Abstracting this method would let an implementer skip steps.
   */
  protected async handleAction(envelope: Message): Promise<Message> {
    // Step 1: Normalise action type (BUTTON_CLICK → CLICK)
    const raw    = envelope.payload as ActionRecord;
    const action = this.normalizeActionType(raw);

    // Step 2: Record in local state
    const state = this.componentState.get(action.componentId);
    if (state) {
      state.actions.push(action);
      state.lastUpdated = new Date().toISOString();
    }

    // Step 3: Echo — immediate acknowledgement to the renderer
    const correlationId = envelope.metadata?.correlationId ?? action.id;
    const echo = this.buildMessage({
      direction: 'ACTION',
      kind:      'ACTION_ECHO',
      payload:   action,
      metadata:  { acknowledged: true, correlationId, error: null },
    });
    this.publish(echo);

    // Step 4: Snapshot — send full current state to the renderer
    if (state) {
      this.publish(this.buildMessage({
        direction: 'COMPONENT',
        kind:      'STATE_SNAPSHOT',
        payload:   {
          component:   state.component,
          actions:     state.actions,
          lastUpdated: state.lastUpdated,
        },
        metadata: { acknowledged: false, correlationId, error: null },
      }));
    }

    // Step 5: Forward to Registry — fire-and-forget
    // The renderer already has echo + snapshot, so we do NOT await this.
    // If forward fails, onForwardError() is called but the renderer is unaffected.
    this.forwardActionToRegistry({ ...envelope, payload: action }).catch(err => {
      this.onForwardError(action.id, err);
    });

    return echo;
  }

  /**
   * Handle a COMPONENT-direction envelope that arrived from a renderer
   * (as opposed to the Registry subscription).
   *
   * Stores the component locally and broadcasts a COMPONENT_UPDATE to all
   * connected renderers.
   *
   * WHY concrete: the store-then-broadcast pattern is universal.
   */
  protected handleInboundComponent(envelope: Message): Message | null {
    const comp = envelope.payload as Component;
    if (!comp?.id) return null;
    this.storeComponent(comp);
    const msg = this.buildMessage({
      direction: 'COMPONENT',
      kind:      'COMPONENT_UPDATE',
      payload:   comp,
    });
    this.publish(msg);
    return msg;
  }

  // ============================================================
  // REGISTRY INBOUND — CONCRETE
  // ============================================================

  /**
   * Called by `connectToRegistry()` when a `next` frame arrives containing
   * a componentUpdate event from the Registry subscription.
   *
   * Stores the component and broadcasts to all renderers.
   *
   * WHY concrete: same store-then-broadcast pattern regardless of direction.
   */
  protected handleComponentFromRegistry(component: Component): void {
    if (!component?.id) return;
    this.storeComponent(component);
    this.publish(this.buildMessage({
      direction: 'COMPONENT',
      kind:      'COMPONENT_UPDATE',
      payload:   component,
    }));
  }

  // ============================================================
  // STATE HELPERS — CONCRETE
  // ============================================================

  /**
   * Upsert a component into the local cache.
   *
   * On UPDATE: replaces the `component` reference and updates `lastUpdated`,
   *   but PRESERVES the existing `actions` array. Overwriting actions on
   *   every component update would erase the history that STATE_SNAPSHOT relies on.
   *
   * On INSERT: initialises an empty actions array.
   *
   * WHY concrete: the upsert semantics are load-bearing. Both implementations
   * must behave identically or renderers get inconsistent snapshots.
   */
  protected storeComponent(component: Component): void {
    const existing = this.componentState.get(component.id);
    if (existing) {
      existing.component   = component;
      existing.lastUpdated = new Date().toISOString();
    } else {
      this.componentState.set(component.id, {
        component,
        actions:     [],
        lastUpdated: new Date().toISOString(),
      });
    }
  }

  /** Return all cached components (used by the `components` GraphQL query resolver). */
  getComponents(): Component[] {
    return Array.from(this.componentState.values()).map(s => s.component);
  }

  /** Return all component states (used by the `componentStates` GraphQL query resolver). */
  getComponentStates(): ComponentState[] {
    return Array.from(this.componentState.values());
  }

  // ============================================================
  // PURE HELPERS — CONCRETE
  // No I/O. Centralised here because both existing implementations
  // use identical logic and having two copies invites drift.
  // ============================================================

  /**
   * Calculate the next reconnect delay using bounded exponential backoff.
   *
   * Formula: delay = min(reconnectMaxMs, reconnectBaseMs * reconnectFactor ^ attempt)
   *
   * Example progression with defaults (base=400, max=5000, factor=1.6):
   *   attempt 0 →   400 ms
   *   attempt 2 →  1024 ms
   *   attempt 5 →  4194 ms
   *   attempt 6 →  5000 ms  ← cap
   *
   * WHY concrete: this exact formula appears in both simple-daemon.js and
   * the Rust implementation. Centralising it means tuning one constant
   * changes behaviour everywhere and unit tests verify the formula once.
   *
   * @param attempt  Zero-based attempt counter (increment BEFORE calling this).
   * @returns        Milliseconds to wait before the next connection attempt.
   */
  protected reconnectDelayMs(attempt: number): number {
    return Math.min(
      this.reconnectMaxMs,
      this.reconnectBaseMs * Math.pow(this.reconnectFactor, attempt),
    );
  }

  /**
   * Normalise a raw action type from a browser renderer.
   *
   * Browser `click` events are often encoded as BUTTON_CLICK by renderers.
   * The Registry only understands CLICK. This normalisation must happen in
   * the daemon so the Registry schema stays clean of browser-ism.
   *
   * The original type is preserved in `data.originalActionType` so audit
   * trails downstream can distinguish "user pressed a button" from
   * "programmatic click".
   *
   * WHY concrete: the mapping is a business rule of the control plane
   * protocol, not an implementation detail. Both implementations apply it
   * identically.
   */
  protected normalizeActionType(action: ActionRecord): ActionRecord {
    if (action.actionType === 'BUTTON_CLICK') {
      return {
        ...action,
        actionType: 'CLICK',
        data: { ...action.data, originalActionType: 'BUTTON_CLICK' },
      };
    }
    return action;
  }

  /**
   * Construct a well-formed `Message` envelope with consistent metadata defaults.
   *
   * WHY concrete: both implementations use the same metadata defaults
   * (acknowledged=false, a fresh correlationId when none is supplied,
   * error=null). Letting each implementation construct envelopes ad-hoc
   * invites drift in the metadata shape.
   */
  protected buildMessage(parts: {
    direction: MessageDirection;
    kind:      MessageKind;
    payload:   Message['payload'];
    metadata?: Partial<MessageMetadata>;
  }): Message {
    return {
      direction: parts.direction,
      kind:      parts.kind,
      payload:   parts.payload,
      metadata: {
        acknowledged:  parts.metadata?.acknowledged  ?? false,
        correlationId: parts.metadata?.correlationId ?? this.generateId(),
        error:         parts.metadata?.error         ?? null,
      },
    };
  }

  /**
   * Generate a unique ID for use as a correlationId or message ID.
   *
   * Default implementation uses `crypto.randomUUID()`, which is available in
   * Node.js 15+, all modern browsers, and Deno. Override this method if your
   * target environment lacks it (e.g. React Native, Node 14).
   */
  protected generateId(): string {
    return crypto.randomUUID();
  }

  /**
   * Hook called when `forwardActionToRegistry()` rejects.
   *
   * Default: no-op (error is silently swallowed, matching the current
   * Node.js and Rust behaviour). Override to add structured logging,
   * metrics, or a dead-letter queue:
   *
   *   protected onForwardError(actionId: string, error: unknown): void {
   *     console.error(`[DAEMON] ACTION_FORWARD_ERROR id=${actionId}`, error);
   *     metrics.increment('daemon.forward.error');
   *   }
   */
  protected onForwardError(_actionId: string, _error: unknown): void {
    // intentional no-op — override to add observability
  }
}
