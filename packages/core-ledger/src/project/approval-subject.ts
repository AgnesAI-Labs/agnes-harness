import { parsePrefixScope } from '@agnes/core-common/command-table/prefix'
import { canonicalJson } from '@agnes/core-common/request/hash'
import type { Actor, UINode } from '@agnes/protocol'
import { clipUtf16 } from './clip.js'

export type ApprovalNode = Extract<UINode, { kind: 'approval' }>

/**
 * What a card reads off the recorded decision subject: technical content, risk and the platform's
 * summary of a question a hook rewrote. The original subject stays in the decision record.
 */
export function approvalSubject(
  subject: unknown,
): Pick<ApprovalNode, 'risk' | 'rewrite' | 'subjectText' | 'toolName'> {
  const facts = subject as {
    call?: { name?: unknown }
    risk?: ApprovalNode['risk']
    rewrite?: { by?: unknown; summary?: unknown }
  } | null
  const rewrite = facts?.rewrite
  const raw = canonicalJson(subject)
  return {
    risk: facts?.risk ?? 'always',
    ...(typeof facts?.call?.name === 'string' && facts.call.name
      ? { toolName: clipUtf16(facts.call.name, 256) }
      : {}),
    subjectText:
      raw.length <= 400_000
        ? raw
        : `${clipUtf16(raw, 399_900)}\n…[showing first 399900 of ${raw.length} chars]`,
    ...(rewrite && typeof rewrite.summary === 'string' && Array.isArray(rewrite.by)
      ? {
          rewrite: {
            by: rewrite.by.filter((source): source is string => typeof source === 'string').slice(0, 16),
            summary: rewrite.summary.slice(0, 4096),
          },
        }
      : {}),
  }
}

/** The tool a core/unknown-outcome decision asks about, as Core named it in the subject. */
export function reconcileTool(subject: unknown): string {
  const name = (subject as { name?: unknown } | null)?.name
  return typeof name === 'string' && name ? name.slice(0, 256) : 'tool'
}

/** The same trusted automatic evidence decorates live and durable tool projections. */
export const automaticToolPermission = (decisionId: string, actor: Actor) => ({
  reason: 'full-access' as const,
  decisionId,
  actor,
})

/** Identity comes only from the recorded operation's tool call, never transcript position. */
export function approvalToolReference(tool: { name: string; toolUseId: string } | undefined) {
  return tool ? { toolName: tool.name, toolUseId: tool.toolUseId } : {}
}

/** The command prefix Core offered with a request, read back from its recorded subject. */
export function prefixGrantOf(subject: unknown): Pick<ApprovalNode, 'prefixGrant'> {
  const offered = (subject as { prefixGrant?: { tokens?: unknown; scope?: unknown } } | null)?.prefixGrant
  const tokens = typeof offered?.scope === 'string' ? parsePrefixScope(offered.scope) : undefined
  return tokens && JSON.stringify(tokens) === JSON.stringify(offered?.tokens)
    ? { prefixGrant: { tokens, scope: offered?.scope as string } }
    : {}
}
