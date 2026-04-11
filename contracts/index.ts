// @control-plane/contracts
// ============================================================
// Single import point for all shared types and the abstract
// DaemonService base class.
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

export { DaemonService } from './DaemonService';

export type {
  Component,
  ActionRecord,
  ComponentState,
  Message,
  MessageDirection,
  MessageKind,
  MessageMetadata,
  ControlPlaneStateResult,
  DaemonConfig,
} from './types';
