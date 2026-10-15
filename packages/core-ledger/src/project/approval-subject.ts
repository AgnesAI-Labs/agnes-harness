import type { UINode } from '@agnes/protocol'

export type ApprovalNode = Extract<UINode, { kind: 'approval' }>

/**
 * What an approval card reads off the decision's subject: the risk, and the platform's own summary
 * of a question a hook rewrote, as Core recorded both.
 */
export function approvalSubject(subject: unknown): Pick<ApprovalNode, 'risk' | 'rewrite'> {
  const facts = subject as {
    risk?: ApprovalNode['risk']
    rewrite?: { by?: unknown; summary?: unknown }
  } | null
  const rewrite = facts?.rewrite
  return {
    risk: facts?.risk ?? 'always',
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
