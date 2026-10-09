import type { Actor, AutoReviewConfig, JsonValue, ToolReviewFact } from '@agnes/protocol'
import type { ResolvedToolCallPolicy } from './tool.js'

export interface ToolPolicyInput {
  sessionKey: string
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
  approvalMode: 'manual' | 'smart' | 'off' | 'auto-review'
  category?: 'read' | 'write' | 'external'
  config?: AutoReviewConfig
  /** Trusted, retained user instructions. Tool arguments and outputs never grant authority. */
  instructions?: readonly string[]
}

export type ToolPolicyDecision = { effect: 'allow' | 'ask' | 'deny'; reason: string; review?: ToolReviewFact }

/** A tool-free model operation and session-wide reservation, both owned by the runtime. */
export interface ToolPolicyPorts {
  reserve(limit: number): boolean | Promise<boolean>
  model(
    request: { slot: 'fast' | 'verifier'; prompt: string },
    signal: AbortSignal,
    onUsage?: (usage: { model: string; cost: number; costSource: 'estimated' | 'gateway' }) => void,
  ): Promise<{ text: string; model: string; cost: number; costSource?: 'estimated' | 'gateway' }>
}

/** Principal authorization remains a host decision and cannot be overridden by a policy. */
export interface ToolPolicy {
  id: string
  version: string
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

export interface ToolPolicyRegistryPort {
  register(sourcePackage: string, policy: ToolPolicy): () => Promise<void>
  resolve(id: string): ToolPolicy
  catalog(): readonly ToolPolicyCatalogEntry[]
}

export interface ToolPolicyPluginContext {
  toolPolicies: ToolPolicyRegistryPort
  effect(callback: () => () => Promise<void>): unknown
}
export function registerToolPolicyPlugin(
  ctx: ToolPolicyPluginContext,
  sourcePackage: string,
  policy: ToolPolicy,
): void {
  ctx.effect(() => ctx.toolPolicies.register(sourcePackage, policy))
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
    const ask =
      !management &&
      !input.fullAccess &&
      input.approvalMode !== 'off' &&
      (input.policy.requiresApproval === 'always' ||
        (input.policy.requiresApproval === 'destructive' && input.policy.isDestructive) ||
        (input.tainted && !input.policy.isReadOnly))
    return {
      effect: ask ? 'ask' : 'allow',
      reason: ask ? 'Tool risk requires approval' : 'Default tool policy',
    }
  },
}
