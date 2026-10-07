import type { Actor, JsonValue } from '@agnes/protocol'
import type { ResolvedToolCallPolicy } from './tool.js'

export interface ToolPolicyInput {
  sessionKey: string
  cwd: string
  actor: Actor
  call: { id: string; name: string; args: JsonValue }
  policy: ResolvedToolCallPolicy
  tainted: boolean
  fullAccess: boolean
  approvalMode: 'manual' | 'smart' | 'off'
}

export type ToolPolicyDecision = { effect: 'allow' | 'ask' | 'deny'; reason: string }

/** Principal authorization remains a host decision and cannot be overridden by a policy. */
export interface ToolPolicy {
  id: string
  version: string
  /** Instance-owned resources, drained before registration cleanup. */
  dispose?(): void | Promise<void>
  cleanup?(): void | Promise<void>
  decide(input: ToolPolicyInput, signal: AbortSignal): ToolPolicyDecision | Promise<ToolPolicyDecision>
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
