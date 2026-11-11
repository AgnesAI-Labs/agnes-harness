import { HARD_BLOCK_RULES, hardBlockedCommand } from '@agnes/core-common/command-table/hard-block'
import type { ToolMeta, ToolPolicy, ToolPolicyDecision, ToolPolicyInput } from '@agnes/extension-api'
import { matchPolicy, normalizeArgv, type PolicyRule } from './normalize.js'
import { commandText, outwardCall, outwardDecision, statefulShell } from './outward.js'

const DENIED: ToolPolicyDecision = { effect: 'deny', reason: 'blocked by the command policy' }
const STATEFUL_REFUSED: ToolPolicyDecision = {
  effect: 'deny',
  reason:
    'Refused: this session holds outward commands for a person, and a terminal or persistent shell keeps history the check cannot see; run each command as a one-shot shell call',
}

/** Whether the session a floor belongs to has outward command rules on (fixed when it opened). */
export type CommandRulesOn = () => boolean
/** Every policy a session floor built, with the switch of the session it serves. */
const FLOORS = new WeakMap<ToolPolicy, CommandRulesOn>()

/**
 * Carry a floor's facts to a policy that wraps it without loosening it (a role's captured authority
 * returns the floored decision unless it denies), so the outer policy answers the predicate below.
 */
export function carriesFloor(outer: ToolPolicy, inner: ToolPolicy): ToolPolicy {
  const commandRules = FLOORS.get(inner)
  if (commandRules) FLOORS.set(outer, commandRules)
  return outer
}

/**
 * Whether `policy` is a session's floored policy and that session has outward command rules on.
 * Structural facts only: a policy built outside the floor is false whatever it answers.
 */
export function outwardCheckpointEnforced(policy: ToolPolicy): boolean {
  return FLOORS.get(policy)?.() === true
}

/**
 * The hard-block rule a shell-like call trips, if any. Code-shipped and independent of every preset,
 * permission mode, approval mode and grant; the dispatcher and the floor both ask it.
 */
export function hardBlockedCall(
  tool: string,
  args: unknown,
  commandArg?: string,
): { id: string; reason: string } | undefined {
  // Any tool that declares a command argument is covered; built-in shells are backfilled.
  const text = commandText(tool, args, commandArg)
  if (text === undefined) return undefined
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

/**
 * What a tool declared that the floor reads beyond its command argument: whether it is outward
 * (`ToolMeta.outward`) and the URI schemes its `path` argument names other than a workspace path
 * (`ToolMeta.paths[].nonWorkspaceSchemes`). Identity resolution belongs to `normalizeArgv`; the
 * floor only forwards what the tool itself declared.
 */
export type DeclaredMetaOf = (tool: string) => Pick<ToolMeta, 'outward' | 'paths'> | undefined

const nonWorkspaceSchemes = (meta: ReturnType<DeclaredMetaOf>) =>
  meta?.paths?.find((path) => path.arg === 'path')?.nonWorkspaceSchemes

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
 *
 * An outward call (see `outwardCall`) is held for a person whatever the table or the policy says,
 * unless one of them denies it. With `commandRules` on, a terminal or persistent shell is refused.
 */
export function withCommandFloor(
  policy: ToolPolicy,
  rules: readonly PolicyRule[],
  commandArgOf: CommandArgOf = () => undefined,
  pathScope?: CommandPathScope,
  declaredMetaOf: DeclaredMetaOf = () => undefined,
  commandRulesOn: CommandRulesOn = () => false,
): ToolPolicy {
  const floored: ToolPolicy = {
    ...policy,
    async decide(input, signal, ports) {
      signal.throwIfAborted()
      const commandArg = commandArgOf(input.call.name)
      const hard = hardBlockedCall(input.call.name, input.call.args, commandArg)
      if (hard) return { effect: 'deny', reason: hard.reason }
      const declared = declaredMetaOf(input.call.name)
      const commandRules = commandRulesOn()
      if (commandRules && declared?.outward !== true && statefulShell(input.call.name, input.call.args))
        return STATEFUL_REFUSED
      const outward = outwardCall(
        input.call.name,
        input.call.args,
        commandArg,
        declared?.outward === true,
        commandRules,
      )
      let argv: string
      let scope: { root: string } | undefined
      try {
        scope = await pathScope?.(input, signal)
        signal.throwIfAborted()
        argv = normalizeArgv(
          input.call.name,
          input.call.args,
          input.workspaceRoot,
          commandArg,
          scope?.root,
          nonWorkspaceSchemes(declared),
        )
      } catch {
        signal.throwIfAborted()
        // No identity to match a rule against, so no rule may vouch for the call.
        return DENIED
      }
      const action = matchPolicy(rules, input.call.name, argv) ?? (scope ? 'allow' : undefined)
      if (action === 'deny') return DENIED
      const decision = await policy.decide(input, signal, ports)
      if (outward) return outwardDecision(decision, outward, input)
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
  FLOORS.set(floored, commandRulesOn)
  return floored
}

/**
 * One session's floor: the table of the preset the session runs under, around the policy it
 * selected. An empty table still carries the code-shipped hard block.
 *
 * The same policy under an equal table is the same object. Callers compare resolved policies by
 * identity to notice a mid-decision policy change, and a preset view rebuilt with the same rules is
 * not such a change while a different table is.
 */
export function sessionCommandFloor(
  commandArgOf: CommandArgOf,
  pathScope?: CommandPathScope,
  declaredMetaOf: DeclaredMetaOf = () => undefined,
  commandRulesOn: CommandRulesOn = () => false,
) {
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
      wrapped = withCommandFloor(policy, rules ?? [], commandArgOf, pathScope, declaredMetaOf, commandRulesOn)
      tables.set(key, wrapped)
    }
    return wrapped
  }
}
