import type { PermissionOptionKind } from '../../gen/ts/acp.js'

export type ApprovalVerdict =
  | 'allowed-once'
  | 'allowed-session'
  | 'allowed-permanent'
  | 'rejected'
  | 'cancelled'
  | 'unavailable'
// Same as stop-reason.ts: rather than hand-copying ACP's four PermissionOptionKind values, take them
// from the generated module. An upstream rename or added value leaves fromAcpOptionKind's exhaustive
// switch missing a branch, so typecheck fails.
// (ApprovalVerdict is this repo's own verdict vocabulary, with no counterpart in the current schema,
// so it stays hand-written.)
export type AcpPermissionKind = PermissionOptionKind

export const OFFERED_OPTION_KINDS = ['allow_once', 'allow_always', 'reject_once'] as const

export function toAcpOptionKind(v: 'allowed-once' | 'allowed-session' | 'rejected'): AcpPermissionKind {
  return v === 'allowed-once' ? 'allow_once' : v === 'allowed-session' ? 'allow_always' : 'reject_once'
}

export function fromAcpOptionKind(k: AcpPermissionKind): ApprovalVerdict {
  switch (k) {
    case 'allow_once':
      return 'allowed-once'
    case 'allow_always':
      return 'allowed-session'
    case 'reject_once':
    case 'reject_always':
      return 'rejected'
  }
}
