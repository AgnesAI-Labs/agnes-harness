import { outwardCommand, outwardRuleDescription } from '@agnes/core-common/command-table/outward'
import { canonicalJson, sha256Hex } from '@agnes/core-common/request/hash'
import type { ToolPolicyDecision, ToolPolicyInput } from '@agnes/extension-api'

/** Built-in shell tools and the argument that carries their text, for when none is declared. */
const SHELL_TOOL_ARG: Record<string, string> = { shell: 'command', pty_send: 'text' }

/** The command text a call runs, from its declared command argument or a built-in shell's. */
export function commandText(tool: string, args: unknown, commandArg?: string): string | undefined {
  const arg = commandArg ?? (Object.hasOwn(SHELL_TOOL_ARG, tool) ? SHELL_TOOL_ARG[tool] : undefined)
  const text = arg === undefined ? undefined : (args as Record<string, unknown> | null | undefined)?.[arg]
  return typeof text === 'string' ? text : undefined
}

/** Tools whose command argument is program source, not shell text: never read with shell rules. */
const SOURCE_TOOLS = new Set(['run_code'])

/**
 * A terminal or shell that keeps history and state between calls. Command rules read one call's
 * text, so a later call could replay or finish an earlier one (`!!`, the up arrow, the second half
 * of a word) without a rule word in its own text. A session with command rules refuses these.
 */
export function statefulShell(tool: string, args: unknown): boolean {
  if (tool === 'pty_open' || tool === 'pty_send') return true
  const shell = args as { persistent?: unknown; sessionId?: unknown } | null | undefined
  return tool === 'shell' && (Boolean(shell?.persistent) || shell?.sessionId !== undefined)
}

export type OutwardHit = { rule: string; reason: string }

/**
 * Why a call is outward: the tool declared itself outward (`ToolMeta.outward`), in every session; or,
 * in a session with command rules on, its shell text trips a rule. Undefined: no outward checkpoint.
 */
export function outwardCall(
  tool: string,
  args: unknown,
  commandArg: string | undefined,
  declaredOutward: boolean,
  commandRules: boolean,
): OutwardHit | undefined {
  if (declaredOutward)
    return { rule: 'declared', reason: 'The tool sends content outward; a person approves each call' }
  if (!commandRules || SOURCE_TOOLS.has(tool)) return undefined
  const text = commandText(tool, args, commandArg)
  const rule = text === undefined ? undefined : outwardCommand(text)
  if (!rule) return undefined
  return { rule, reason: `Outward command (${outwardRuleDescription(rule)}); a person approves each call` }
}

/**
 * The outward checkpoint over whatever the session's policy decided: a denial stands, anything else
 * becomes a question only a person may answer, once, for exactly this call.
 */
export function outwardDecision(
  decision: ToolPolicyDecision,
  hit: OutwardHit,
  input: Pick<ToolPolicyInput, 'call'>,
): ToolPolicyDecision {
  if (decision.effect === 'deny') return decision
  return {
    effect: 'ask',
    reason: hit.reason,
    approval: {
      reviewerRequirement: 'human',
      grantConstraints: 'once',
      checkpoint: 'outward',
      subjectRevision: sha256Hex(
        canonicalJson({ rule: hit.rule, tool: input.call.name, args: input.call.args }),
      ),
    },
    // A reviewer's escalation agrees with the question; its allow is not recorded beside a question.
    ...(decision.review?.decision === 'escalate' ? { review: decision.review } : {}),
  }
}
