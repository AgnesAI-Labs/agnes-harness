import type { ToolPolicy, ToolPolicyDecision, ToolPolicyRegistryPort } from '@agnes/extension-api'
import { matchPolicy, normalizeArgv, type PolicyRule } from './normalize.js'

const DENIED: ToolPolicyDecision = { effect: 'deny', reason: 'blocked by the command policy' }

/**
 * The command table as a deployment safety floor, installed by the Host around whichever tool
 * policy a session selected.
 *
 * A rule can end the question early in only two ways: deny refuses, and allow lets a call that the
 * selected policy would ask about proceed. A selected policy may tighten the answer, never loosen it
 * past the table: its own deny or human-only requirement stands. Allow never overrides an `always`
 * tool, or tainted context outside a path-scoped approval: a rule cannot pre-approve a call the
 * model may have been talked into.
 */
export function withCommandFloor(policy: ToolPolicy, rules: readonly PolicyRule[]): ToolPolicy {
  return {
    ...policy,
    async decide(input, signal, ports) {
      signal.throwIfAborted()
      let argv: string
      try {
        argv = normalizeArgv(input.call.name, input.call.args, input.workspaceRoot)
      } catch {
        // No identity to match a rule against, so no rule may vouch for the call.
        return DENIED
      }
      const action = matchPolicy(rules, input.call.name, argv)
      if (action === 'deny') return DENIED
      const decision = await policy.decide(input, signal, ports)
      if (action !== 'allow' || decision.effect !== 'ask' || decision.approval !== undefined) return decision
      if (input.policy.requiresApproval === 'always') return decision
      if (input.tainted) {
        const scopes = [...new Set(input.policy.approvalScopes)]
        if (scopes.length === 0 || !scopes.every((scope) => scope.includes('/'))) return decision
      }
      return {
        effect: 'allow',
        reason: 'Allowed by the command policy',
        ...(decision.review ? { review: decision.review } : {}),
      }
    },
  }
}

/** The registry the Kernel resolves policies from, with the floor around every one. An empty table is no floor. */
export function withCommandFloorRegistry(
  registry: ToolPolicyRegistryPort,
  rules: readonly PolicyRule[],
): ToolPolicyRegistryPort {
  if (rules.length === 0) return registry
  // Callers compare resolved policies by identity to notice a mid-decision policy change.
  const wrapped = new WeakMap<ToolPolicy, ToolPolicy>()
  return {
    ...registry,
    resolve(id) {
      const policy = registry.resolve(id)
      let floored = wrapped.get(policy)
      if (!floored) {
        floored = withCommandFloor(policy, rules)
        wrapped.set(policy, floored)
      }
      return floored
    },
  }
}
