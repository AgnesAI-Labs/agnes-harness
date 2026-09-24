import type { JsonValue } from '@agnes/protocol'

/**
 * One immutable view of the workspace hook configuration selected for an invocation.
 *
 * The Host owns parsing and policy lookup. Extension-facing code receives data only: it cannot
 * choose another workspace, policy revision, loader, or filesystem capability.
 */
export type HookInvocationSnapshot = Readonly<{
  workspaceDigest: string
  policyRevision: string
  hooks: readonly JsonValue[]
}>
