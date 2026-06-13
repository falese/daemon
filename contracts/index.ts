// @control-plane/contracts
// ============================================================
// Single import point for the daemon-side control-plane contract.
//
// The wire protocol itself (Message envelope, ActionRecord, Resolution,
// RenderedExperience, SessionContext, guards) is defined once in
// `@seans-mfe/contracts` (ADR-054 in seans-mfe-tool) and re-exported here;
// this package adds the daemon abstractions on top of it.
//
// Usage in an implementing package:
//
//   import { DaemonService }                from '@control-plane/contracts';
//   import type { Message, DaemonConfig }   from '@control-plane/contracts';
//
// Usage in a consuming package (MFE, renderer):
//
//   import type { Message, ControlPlaneStateResult } from '@control-plane/contracts';
// ============================================================

export {
  DaemonService,
  type DaemonServiceConfig,
  type DaemonServiceDeps,
} from './DaemonService';

export {
  HttpMfeInvoker,
  StaticMfeDirectory,
  type HttpMfeInvokerOptions,
  type MfeDirectory,
  type MfeInvocationContext,
  type MfeInvoker,
} from './MfeInvoker';

export type {
  // Canonical protocol (re-exported from @seans-mfe/contracts)
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
  // Daemon migration envelope
  Component,
  ComponentState,
  Message,
  ResolutionEnvelopeData,
} from './types';

export {
  buildMessage,
  EXPERIENCE_COMPONENT_TYPE,
  EXPERIENCE_CONTENT_TYPES,
  experienceFromComponent,
  isActionRecord,
  isRenderedExperience,
  isResolution,
  RESOLUTION_COMPONENT_TYPE,
  RESOLUTION_ERROR_COMPONENT_TYPE,
  resolutionFromComponent,
  toExperienceComponent,
} from './types';
