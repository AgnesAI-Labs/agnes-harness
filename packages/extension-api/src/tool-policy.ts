import type { Actor, JsonValue, ToolReviewFact } from '@agnes/protocol'
import type { ResolvedToolCallPolicy } from './tool.js'

export interface ToolPolicyInput {
  sessionKey: string
  /** Host-injected canonical workspace identity. Use for workspace-owned state, policy and config; grants no authority. */
  readonly workspaceRoot: string
  /** Execution directory snapshot at the start of this call (or the explicitly requested operation).
   * May differ from workspaceRoot in a future version; use workspaceRoot for workspace-owned state, policy and config.
   * Session defaults currently equal workspaceRoot; explicit process/child overrides do not change workspace identity.
   */
  cwd: string
  actor: Actor
  call: {
    id: string
    name: string
    args: JsonValue
    description?: string
    parameters?: JsonValue
    definitionFingerprint?: string
  }
  policy: ResolvedToolCallPolicy
  tainted: boolean
  fullAccess: boolean
  approvalMode: 'manual' | 'off' | 'auto-review'
  category?: 'read' | 'write' | 'external'
  config?: JsonValue
  /** Trusted, retained user instructions. Tool arguments and outputs never grant authority. */
  instructions?: readonly string[]
}

/** Backend constraints; advisory reviewers and grants cannot relax them. */
export type ApprovalConstraints = Readonly<{
  reviewerRequirement: 'human'
  grantConstraints: 'once'
  subjectRevision: string
}>
export type ToolPolicyDecision = {
  effect: 'allow' | 'ask' | 'deny'
  reason: string
  review?: ToolReviewFact
  /**
   * Set when a deployment rule, not the selected policy, produced an `allow` for a call the policy
   * would have asked about. `review` then stays the policy's own observation, so its `escalate`
   * decision may accompany this `allow`.
   */
  allowedBy?: 'command-policy'
  approval?: ApprovalConstraints
}

/**
 * Runtime-owned ports for advisory tool review. They provide no tool execution or authorization;
 * the runtime still enforces the returned policy decision and any required human approval.
 */
export interface ToolPolicyPorts {
  /** Reserve one review against the session-wide limit before calling model; false means exhausted. */
  reserve(limit: number): boolean | Promise<boolean>
  /** Run a tool-free request on the selected slot, respecting cancellation and reporting available usage. */
  model(
    request: { slot: 'fast' | 'verifier'; prompt: string },
    signal: AbortSignal,
    onUsage?: (usage: { model: string; cost: number; costSource: 'estimated' | 'gateway' }) => void,
  ): Promise<{ text: string; model: string; cost: number; costSource?: 'estimated' | 'gateway' }>
}

/** Deployment resources are supplied by Host; interpretation and fallback belong to the selected provider. */
export interface ToolPolicySettingsContext {
  policy: string
  profile: string
  dataDir: string
  approvalMode: ToolPolicyInput['approvalMode']
}
export interface ToolPolicySelection {
  policy?: string
  config?: JsonValue
}

/** Principal authorization remains a host decision and cannot be overridden by a policy. */
export interface ToolPolicy {
  id: string
  version: string
  settings?(context: ToolPolicySettingsContext, signal: AbortSignal): Promise<ToolPolicySelection>
  /** Instance-owned resources, drained before registration cleanup. */
  dispose?(): void | Promise<void>
  cleanup?(): void | Promise<void>
  decide(
    input: ToolPolicyInput,
    signal: AbortSignal,
    ports?: ToolPolicyPorts,
  ): ToolPolicyDecision | Promise<ToolPolicyDecision>
}

export interface ToolPolicyCatalogEntry {
  id: string
  version: string
  sourcePackage: string
}

/** Backend selection contract; plugins register through providers. */
export interface ToolPolicyRegistryPort {
  register(sourcePackage: string, policy: ToolPolicy): () => Promise<void>
  resolve(id: string): ToolPolicy
  catalog(): readonly ToolPolicyCatalogEntry[]
}

/** Experimental default risk decision; authorization and durable approval stay in the host. */
export const defaultToolPolicy: ToolPolicy = {
  id: 'default',
  version: '1.0.0',
  decide(input, signal) {
    signal.throwIfAborted()
    const management = [
      'subagent_fork',
      'subagent_spawn',
      'subagent_collect',
      'subagent_cancel',
      'subagent_list',
      'subagent_send_message',
      'subagent_interrupt',
    ].includes(input.call.name)
    // A presentational tool only publishes display state. Tainted input does not escalate it.
    // requiresApproval "always" and a destructive declaration still ask.
    const ask =
      !management &&
      !input.fullAccess &&
      input.approvalMode !== 'off' &&
      (input.policy.requiresApproval === 'always' ||
        (input.policy.requiresApproval === 'destructive' && input.policy.isDestructive) ||
        (input.tainted && !input.policy.isReadOnly && !input.policy.isPresentational))
    return {
      effect: ask ? 'ask' : 'allow',
      reason: ask
        ? input.tainted && !input.policy.isReadOnly && !input.policy.isPresentational
          ? 'This turn contains untrusted tool output; changes require approval'
          : 'The tool declares an action requiring approval'
        : 'Default tool policy',
    }
  },
}
