import { resolveToolCallPolicy } from '@agnes/extension-api'
import type { JsonValue, ResolvedToolCallPolicy as PersistedToolCallPolicy } from '@agnes/protocol'
import { canonicalJson, sha256Hex } from '../request/hash.js'
import type { ExecutionDomain, RegisteredTool } from './tools.js'

export type CompleteResolvedToolCallPolicy = PersistedToolCallPolicy &
  Readonly<{
    isConcurrencySafe: boolean
    isOpenWorld: boolean
  }>

export type ResolvedToolPolicyEnvelope = Readonly<{
  resolvedPolicy: CompleteResolvedToolCallPolicy
  policyHash: string
  definitionFingerprint: string
  executionDomain: ExecutionDomain
}>

export type PersistedToolPolicyFields = {
  resolvedPolicy?: PersistedToolCallPolicy
  policyHash?: string
  definitionFingerprint?: string
  executionDomain?: ExecutionDomain
}

type CompletePersistedToolPolicyFields = Omit<Required<PersistedToolPolicyFields>, 'resolvedPolicy'> & {
  resolvedPolicy: CompleteResolvedToolCallPolicy
}

export function resolvedToolPolicyHash(policy: PersistedToolCallPolicy): string {
  return sha256Hex(canonicalJson(policy))
}

/**
 * Verify the durable policy binding before any later phase consumes it. The hash is deliberately
 * recomputed from the persisted policy object: merely carrying a 64-character value proves shape,
 * not that the policy and its binding still agree after storage, migration, or manual repair.
 */
export function hasAuthenticToolPolicyHash(input: {
  resolvedPolicy?: PersistedToolCallPolicy
  policyHash?: string
}): boolean {
  return (
    input.resolvedPolicy !== undefined &&
    input.policyHash !== undefined &&
    input.policyHash === resolvedToolPolicyHash(input.resolvedPolicy)
  )
}

export function hasCompleteToolPolicyEnvelope(
  input: PersistedToolPolicyFields | undefined,
): input is CompletePersistedToolPolicyFields {
  return (
    input?.resolvedPolicy !== undefined &&
    typeof input.resolvedPolicy.isConcurrencySafe === 'boolean' &&
    typeof input.resolvedPolicy.isOpenWorld === 'boolean' &&
    input.policyHash !== undefined &&
    input.definitionFingerprint !== undefined &&
    input.executionDomain !== undefined
  )
}

/** Only a kernel-normalized model call may supply executable arguments or durable call policy. */
export function hasTrustedToolCallProvenance(
  event: Readonly<{ type?: unknown; origin?: unknown; trust?: unknown }> | null | undefined,
): boolean {
  return event?.type === 'tool/call' && event.origin === 'model' && event.trust === 'trusted'
}

function comparableEnvelope(input: CompletePersistedToolPolicyFields): ResolvedToolPolicyEnvelope {
  return {
    resolvedPolicy: input.resolvedPolicy,
    policyHash: input.policyHash,
    definitionFingerprint: input.definitionFingerprint,
    executionDomain: input.executionDomain,
  }
}

export type ToolPolicyBindingProblem = 'missing' | 'ledger-state-mismatch' | 'hash-mismatch'

/** Exact ledger ↔ operation-state binding check shared by first dispatch and crash recovery. */
export function toolPolicyBindingProblem(
  state: PersistedToolPolicyFields | undefined,
  ledger: PersistedToolPolicyFields | undefined,
): ToolPolicyBindingProblem | undefined {
  if (!hasCompleteToolPolicyEnvelope(state) || !hasCompleteToolPolicyEnvelope(ledger)) return 'missing'
  if (canonicalJson(comparableEnvelope(state)) !== canonicalJson(comparableEnvelope(ledger)))
    return 'ledger-state-mismatch'
  if (!hasAuthenticToolPolicyHash(state) || !hasAuthenticToolPolicyHash(ledger)) return 'hash-mismatch'
  return undefined
}

/**
 * Resolve the policy exactly once, after the caller has schema-validated args. The returned
 * envelope is the complete persisted input for every later safety consumer; no later phase may
 * invoke the classifier or reconstruct policy from mutable tool metadata.
 */
export function resolveValidatedToolCallPolicy(
  tool: RegisteredTool,
  validatedArgs: JsonValue,
): ResolvedToolPolicyEnvelope {
  const callPolicy = resolveToolCallPolicy(tool, validatedArgs as never)
  const approvalScopes = [...callPolicy.approvalScopes]
  Object.freeze(approvalScopes)
  const resolvedPolicy: CompleteResolvedToolCallPolicy = Object.freeze({
    isReadOnly: callPolicy.isReadOnly,
    isDestructive: callPolicy.isDestructive,
    isConcurrencySafe: tool.meta.isConcurrencySafe,
    isOpenWorld: tool.meta.isOpenWorld,
    replay: callPolicy.replay,
    requiresApproval: callPolicy.requiresApproval,
    approvalScopes,
    policyVersion: tool.policyVersion ?? 'static-v1',
  })
  return Object.freeze({
    resolvedPolicy,
    policyHash: resolvedToolPolicyHash(resolvedPolicy),
    definitionFingerprint: tool.definitionFingerprint,
    executionDomain: tool.executionDomain,
  })
}
