import type { ToolPolicy, ToolPolicyDecision } from '@agnes/extension-api'
import { matchPolicy, normalizeArgv, type PolicyRule } from './normalize.js'

const DENIED: ToolPolicyDecision = { effect: 'deny', reason: 'blocked by the command policy' }

/** The argument a tool declared as its command text (`ToolMeta.commandArg`), if it declared one. */
export type CommandArgOf = (tool: string) => string | undefined

/**
 * The command table as a safety floor around whichever tool policy a session selected.
 *
 * A rule can end the question early in only two ways: deny refuses, and allow lets a call that the
 * selected policy would ask about proceed. A selected policy may tighten the answer, never loosen it
 * past the table: its own deny or human-only requirement stands. Allow never overrides an `always`
 * tool, or tainted context outside a path-scoped approval: a rule cannot pre-approve a call the
 * model may have been talked into.
 */
export function withCommandFloor(
  policy: ToolPolicy,
  rules: readonly PolicyRule[],
  commandArgOf: CommandArgOf = () => undefined,
): ToolPolicy {
  return {
    ...policy,
    async decide(input, signal, ports) {
      signal.throwIfAborted()
      let argv: string
      try {
        argv = normalizeArgv(
          input.call.name,
          input.call.args,
          input.workspaceRoot,
          commandArgOf(input.call.name),
        )
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
        allowedBy: 'command-policy',
        ...(decision.review ? { review: decision.review } : {}),
      }
    },
  }
}

/**
 * One session's floor: the table of the preset the session runs under, around the policy it
 * selected. An empty table is no floor.
 *
 * The same policy under an equal table is the same object. Callers compare resolved policies by
 * identity to notice a mid-decision policy change, and a preset view rebuilt with the same rules is
 * not such a change while a different table is.
 */
export function sessionCommandFloor(commandArgOf: CommandArgOf) {
  const floored = new WeakMap<ToolPolicy, Map<string, ToolPolicy>>()
  return (policy: ToolPolicy, rules: readonly PolicyRule[] | undefined): ToolPolicy => {
    if (!rules?.length) return policy
    const key = JSON.stringify(rules.map((rule) => [rule.tool, rule.argv, rule.action]))
    let tables = floored.get(policy)
    if (!tables) {
      tables = new Map()
      floored.set(policy, tables)
    }
    let wrapped = tables.get(key)
    if (!wrapped) {
      wrapped = withCommandFloor(policy, rules, commandArgOf)
      tables.set(key, wrapped)
    }
    return wrapped
  }
}
