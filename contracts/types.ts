// ============================================================
// CONTROL PLANE — SHARED TYPES
// ============================================================
// As of ADR-054 (seans-mfe-tool) the wire protocol is defined ONCE in
// `@seans-mfe/contracts/messages` and re-exported here. This file adds only
// what is daemon-specific:
//
//   • the legacy `Component` / `ComponentState` shapes that deployed
//     renderers and the Rust daemon still exchange (migration envelope), and
//   • the helpers that let canonical payloads (Resolution,
//     RenderedExperience) ride inside that envelope without a breaking
//     GraphQL schema change.
//
// Until `@seans-mfe/contracts` is published to npm it is consumed as a
// vendored tarball (`vendor/seans-mfe-contracts-<version>.tgz`) produced by
// `npm pack` in seans-mfe-tool/packages/contracts.
// ============================================================

import type {
  ActionRecord,
  MessageDirection,
  MessageKind,
  MessageMetadata,
  RenderedExperience,
  Resolution,
} from '@seans-mfe/contracts';
import { isRenderedExperience, isResolution } from '@seans-mfe/contracts';

// ── Canonical protocol (single source of truth) ──────────────
export type {
  ActionRecord,
  ControlPlaneStateResult,
  ControlPlaneUser,
  DaemonConfig,
  ExperienceState,
  MessageDirection,
  MessageKind,
  MessageMetadata,
  MfeRegistration,
  RenderedExperience,
  Resolution,
  SessionContext,
} from '@seans-mfe/contracts';
export {
  buildMessage,
  EXPERIENCE_CONTENT_TYPES,
  isActionRecord,
  isRenderedExperience,
  isResolution,
} from '@seans-mfe/contracts';

// ── Legacy migration envelope ────────────────────────────────

/**
 * @deprecated Migration-only. PLATFORM-CONTRACT v3.2 retired fixed component
 * types — new flows carry `RenderedExperience` (type EXPERIENCE) or
 * `Resolution` (type RESOLUTION) in `data`. Kept so deployed renderers and
 * the Rust daemon keep working while they migrate.
 */
export interface Component {
  id: string;
  type: 'CARD' | 'FORM' | 'NOTIFICATION' | string;
  data: Record<string, unknown>;
  createdAt: string; // ISO-8601
}

/**
 * @deprecated Migration-only counterpart of `Component`; the canonical shape
 * is `ExperienceState`. Payload of STATE_SNAPSHOT messages.
 */
export interface ComponentState {
  component: Component;
  actions: ActionRecord[];
  lastUpdated: string; // ISO-8601
}

/**
 * The daemon's wire envelope. Identical to the canonical `Message` except
 * the payload union still admits the legacy `Component`/`ComponentState`
 * migration shapes alongside the canonical payloads.
 */
export interface Message {
  direction: MessageDirection;
  kind: MessageKind;
  payload: Component | ComponentState | ActionRecord | RenderedExperience;
  metadata: MessageMetadata;
}

// ── Canonical payloads over the migration envelope ───────────

/** Component `type` for a registry resolution riding the legacy envelope. */
export const RESOLUTION_COMPONENT_TYPE = 'RESOLUTION';
/** Component `type` for an MFE-rendered experience riding the legacy envelope. */
export const EXPERIENCE_COMPONENT_TYPE = 'EXPERIENCE';
/** Component `type` published when a resolution could not be fulfilled. */
export const RESOLUTION_ERROR_COMPONENT_TYPE = 'RESOLUTION_ERROR';

/**
 * Extra routing fields the registry may attach beside the resolution so the
 * daemon can thread per-session context and end-to-end correlation.
 */
export interface ResolutionEnvelopeData extends Resolution {
  sessionId?: string;
  correlationId?: string;
  [key: string]: unknown;
}

/** Wrap an MFE-rendered experience as a legacy-envelope component. */
export function toExperienceComponent(experience: RenderedExperience): Component {
  return {
    id: experience.id,
    type: EXPERIENCE_COMPONENT_TYPE,
    data: experience as unknown as Record<string, unknown>,
    createdAt: experience.createdAt,
  };
}

/** Extract a RenderedExperience from an EXPERIENCE component, else null. */
export function experienceFromComponent(component: Component): RenderedExperience | null {
  if (component.type !== EXPERIENCE_COMPONENT_TYPE) return null;
  return isRenderedExperience(component.data) ? component.data : null;
}

/** Extract a registry resolution from a RESOLUTION component, else null. */
export function resolutionFromComponent(component: Component): ResolutionEnvelopeData | null {
  if (component.type !== RESOLUTION_COMPONENT_TYPE) return null;
  return isResolution(component.data) ? (component.data as ResolutionEnvelopeData) : null;
}
