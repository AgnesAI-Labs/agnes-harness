import { HARD_BLOCK_RULES, hardBlockedCommand } from '@agnes/core-common/command-table/hard-block'
import type { ToolPolicy, ToolPolicyDecision, ToolPolicyInput } from '@agnes/extension-api'
import { matchPolicy, normalizeArgv, type PolicyRule } from './normalize.js'

const DENIED: ToolPolicyDecision = { effect: 'deny', reason: 'blocked by the command policy' }

/** Built-in shell tools and the argument that carries their text, for when none is declared. */
const SHELL_TOOL_ARG: Record<string, string> = { shell: 'command', pty_send: 'text' }

/**
 * The hard-block rule a shell-like call trips, if any. Code-shipped and independent of every preset,
 * permission mode, approval mode and grant; the dispatcher and the floor both ask it.
 */
export function hardBlockedCall(
  tool: string,
  args: unknown,
  commandArg?: string,
): { id: string; reason: string } | undefined {
  // Any tool that declares a command argument is covered; the table only backfills built-ins.
  const arg = commandArg ?? (Object.hasOwn(SHELL_TOOL_ARG, tool) ? SHELL_TOOL_ARG[tool] : undefined)
  const text = arg === undefined ? undefined : (args as Record<string, unknown> | null | undefined)?.[arg]
  if (typeof text !== 'string') return undefined
  const id = hardBlockedCommand(text)
  if (!id) return undefined
  const rule = HARD_BLOCK_RULES.find((candidate) => candidate.id === id)
  return {
    id,
    reason: `Refused: this command is hard-blocked (${rule?.description ?? id}) and cannot be approved`,
  }
}

/** The argument a tool declared as its command text (`ToolMeta.commandArg`), if it declared one. */
export type CommandArgOf = (tool: string) => string | undefined

/** Host-owned scope, checked live; it admits identity only, never a filesystem mutation. */
export type CommandPathScope = (
  input: ToolPolicyInput,
  signal: AbortSignal,
) => Promise<{ root: string } | undefined>

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
  pathScope?: CommandPathScope,
): ToolPolicy {
  return {
    ...policy,
    async decide(input, signal, ports) {
      signal.throwIfAborted()
      const hard = hardBlockedCall(input.call.name, input.call.args, commandArgOf(input.call.name))
      if (hard) return { effect: 'deny', reason: hard.reason }
      let argv: string
      let scope: { root: string } | undefined
      try {
        scope = await pathScope?.(input, signal)
        signal.throwIfAborted()
        argv = normalizeArgv(
          input.call.name,
          input.call.args,
          input.workspaceRoot,
          commandArgOf(input.call.name),
          scope?.root,
        )
      } catch {
        signal.throwIfAborted()
        // No identity to match a rule against, so no rule may vouch for the call.
        return DENIED
      }
      const action = matchPolicy(rules, input.call.name, argv) ?? (scope ? 'allow' : undefined)
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
 * selected. An empty table still carries the code-shipped hard block.
 *
 * The same policy under an equal table is the same object. Callers compare resolved policies by
 * identity to notice a mid-decision policy change, and a preset view rebuilt with the same rules is
 * not such a change while a different table is.
 */
export function sessionCommandFloor(commandArgOf: CommandArgOf, pathScope?: CommandPathScope) {
  const floored = new WeakMap<ToolPolicy, Map<string, ToolPolicy>>()
  return (policy: ToolPolicy, rules: readonly PolicyRule[] | undefined): ToolPolicy => {
    // An empty table still gets the floor: the hard block does not come from the table.
    const key = JSON.stringify((rules ?? []).map((rule) => [rule.tool, rule.argv, rule.action]))
    let tables = floored.get(policy)
    if (!tables) {
      tables = new Map()
      floored.set(policy, tables)
    }
    let wrapped = tables.get(key)
    if (!wrapped) {
      wrapped = withCommandFloor(policy, rules ?? [], commandArgOf, pathScope)
      tables.set(key, wrapped)
    }
    return wrapped
  }
}
