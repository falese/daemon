// ============================================================
// CONTROL PLANE — SHARED TYPES
// ============================================================
// These interfaces define every type that crosses a service
// boundary in the control plane: components, actions, the
// message envelope, and configuration.
//
// Design notes
// ─────────────
// • Every field maps 1-to-1 to a GraphQL field in the daemon
//   schema, so a daemon author can validate the schema against
//   these types with minimal glue.
// • `data` and `payload` are intentionally open (Record /
//   union) because the registry may introduce new component
//   types or rule-generated shapes without requiring a
//   contracts version bump.
// • ISO-8601 strings are used for all timestamps rather than
//   Date objects so types remain JSON-serialisable by default.
// ============================================================

// ── Primitive domain types ───────────────────────────────────

/**
 * A UI component pushed from the Registry through the Daemon to a Renderer.
 *
 * `type` is a discriminator: 'CARD', 'FORM', 'NOTIFICATION' are the canonical
 * values today (see the rules engine defaults), but implementations MUST tolerate
 * unknown strings so future types don't break existing daemons.
 */
export interface Component {
  id: string;
  type: 'CARD' | 'FORM' | 'NOTIFICATION' | string;
  data: Record<string, unknown>;
  createdAt: string; // ISO-8601
}

/**
 * A user-initiated action flowing up from Renderer → Daemon → Registry.
 *
 * The daemon is responsible for normalising raw browser action types before
 * forwarding (see `DaemonService.normalizeActionType`). Canonical values after
 * normalisation: CLICK | SUBMIT. Raw renderers may send BUTTON_CLICK.
 *
 * `data` carries the action payload (e.g. submitted form field values).
 */
export interface ActionRecord {
  id: string;
  componentId: string;
  /** Canonical: CLICK | SUBMIT. Raw browser value BUTTON_CLICK is normalised
   *  by the daemon to CLICK before forwarding to the registry. */
  actionType: string;
  data: Record<string, unknown>;
  timestamp: string; // ISO-8601
}

/**
 * The daemon's per-component state entry: the component itself plus every
 * action the renderer has submitted against it since the component was received.
 *
 * This is the payload of a STATE_SNAPSHOT message. It gives the renderer a
 * complete picture of what the daemon knows about a component without making
 * a separate query.
 */
export interface ComponentState {
  component: Component;
  actions: ActionRecord[];
  lastUpdated: string; // ISO-8601
}

// ── Message envelope ─────────────────────────────────────────

/**
 * Indicates the direction of data flow:
 *   COMPONENT = data flowing DOWN  (Registry → Daemon → Renderer)
 *   ACTION    = data flowing UP    (Renderer → Daemon → Registry)
 */
export type MessageDirection = 'COMPONENT' | 'ACTION';

/**
 * Discriminates the specific purpose of a message:
 *
 *   COMPONENT_UPDATE  — a new or changed component pushed to the renderer
 *   STATE_SNAPSHOT    — full current state for one component (sent immediately
 *                       after an action so the renderer doesn't have to re-query)
 *   ACTION_ECHO       — immediate ack that the daemon received an action
 *   ACTION            — raw upward action (set by the renderer)
 */
export type MessageKind =
  | 'COMPONENT_UPDATE'
  | 'STATE_SNAPSHOT'
  | 'ACTION_ECHO'
  | 'ACTION';

export interface MessageMetadata {
  /**
   * UUID shared between the original renderer request and every downstream
   * message it produces. Lets a renderer correlate the echo, snapshot, and
   * eventual rule-generated component update for a single user action.
   */
  correlationId: string;
  /** True once the daemon has processed (not just received) the message. */
  acknowledged: boolean;
  /** Non-null when the daemon or registry rejected or failed to process. */
  error: string | null;
}

/**
 * The wire envelope used for every message on the daemon's `messages` GraphQL
 * subscription. Both directions (COMPONENT and ACTION) share this shape.
 *
 * `payload` type by `kind`:
 *   COMPONENT_UPDATE  → Component
 *   STATE_SNAPSHOT    → ComponentState
 *   ACTION_ECHO       → ActionRecord  (the normalised action)
 *   ACTION            → ActionRecord  (raw, set by the renderer)
 */
export interface Message {
  direction: MessageDirection;
  kind: MessageKind;
  payload: Component | ActionRecord | ComponentState;
  metadata: MessageMetadata;
}

// ── MFE result type ──────────────────────────────────────────

/**
 * Return type for `BaseMFE.updateControlPlaneState()` in the MFE framework.
 *
 * This is the MFE-facing view of what the daemon reports back after processing
 * a state update. It maps directly to the `metadata` fields of the ACTION_ECHO
 * message the daemon publishes in response:
 *
 *   ACTION_ECHO.metadata.acknowledged → ControlPlaneStateResult.acknowledged
 *   ACTION_ECHO.metadata.correlationId → ControlPlaneStateResult.correlationId
 *   ACTION_ECHO.metadata.error → ControlPlaneStateResult.error
 *
 * See DAEMON-CONTRACT.md § "Connection to the MFE" for the full call path.
 */
export interface ControlPlaneStateResult {
  acknowledged: boolean;
  correlationId: string;
  error: string | null;
}

// ── Configuration ────────────────────────────────────────────

/**
 * Minimal configuration accepted by every DaemonService implementation.
 * Concrete implementations may extend this with their own fields.
 *
 * All reconnect constants are exposed here so that tests can inject small
 * values (e.g. reconnectBaseMs: 10) without modifying source code or
 * environment variables.
 */
export interface DaemonConfig {
  /**
   * Full WebSocket URL to the Registry.
   * Default: value of `REGISTRY_WS_URL` environment variable, or
   * `ws://registry:4000/graphql` if the variable is not set.
   */
  registryUrl?: string;
  /** Port the daemon's own GraphQL/WebSocket server listens on. Default: 3001. */
  port?: number;

  // ── Reconnect constants ──────────────────────────────────────
  // These match the constants in simple-daemon.js and main.rs exactly.
  // Changing the defaults here changes behaviour for every implementation
  // that doesn't override them.

  /** Starting delay (ms) for the first reconnect attempt. Default: 400. */
  reconnectBaseMs?: number;
  /** Maximum delay (ms) — backoff is capped at this value. Default: 5000. */
  reconnectMaxMs?: number;
  /** Exponential growth rate per failed attempt. Default: 1.6. */
  reconnectFactor?: number;
  /** Timeout (ms) for a forwarded action mutation to complete. Default: 4000. */
  forwardTimeoutMs?: number;
}
