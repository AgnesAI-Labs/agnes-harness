import { baseToolTitle, localizeToolSummary } from '@agnes/web-ui'
// What the live approval card says about a tool call: what it will do, the arguments it will run with,
// and what the session-wide choice covers. Pure, so the wording and the "can everything be seen"
// rule are tested without a page.

import type { Translate } from './presentation.js'

/** Characters of the arguments the card prints. Past this the card says so and drops the session grant. */
export const PREVIEW_LIMIT = 32 * 1024

/** Argument names that say what a call acts on; they lead the preview whatever order they arrived in. */
const LEADING = ['plan', 'path', 'file_path', 'command', 'url', 'pattern', 'query']

export type ApprovalCard = {
  summary?: string
  impact: string
  preview?: string
  /** Set when part of the call is not on the card. */
  warning?: string
  /** The label for "allow for the session", or undefined when that choice must not be offered. */
  sessionLabel?: string
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export function approvalToolName(toolCall: Record<string, unknown>): string | undefined {
  const meta = toolCall._meta
  const harness = isRecord(meta) ? meta['ai.agnes.harness'] : undefined
  const tool = isRecord(harness) ? harness.tool : undefined
  return typeof tool === 'string' && tool !== '' ? tool : undefined
}

/** Unknown/older transport requests remain visible until the backend classifies them. */
export function approvalIsPermission(toolCall: Record<string, unknown>): boolean {
  const meta = toolCall._meta
  const harness = isRecord(meta) ? meta['ai.agnes.harness'] : undefined
  return isRecord(harness) && harness.category === 'permission'
}

/** Delivery metadata only: the child, rather than its parent turn, owns this question's lifetime. */
export function approvalIsDelegated(toolCall: Record<string, unknown>): boolean {
  const meta = toolCall._meta
  const harness = isRecord(meta) ? meta['ai.agnes.harness'] : undefined
  return isRecord(harness) && isRecord(harness.delegation)
}

/** Translate delivery labels around backend identity and purpose; arguments never supply them. */
function delegatedSummary(
  toolCall: Record<string, unknown>,
  title: string,
  t: Translate,
  tool?: string,
): string {
  const meta = toolCall._meta
  const harness = isRecord(meta) ? meta['ai.agnes.harness'] : undefined
  const delegation = isRecord(harness) ? harness.delegation : undefined
  if (!isRecord(delegation)) return localizeToolSummary(title, t, tool)
  const { role, childSessionKey, reason } = delegation
  if (typeof role !== 'string' || typeof childSessionKey !== 'string' || typeof reason !== 'string')
    return localizeToolSummary(title, t, tool)
  const prefix = `Role ${role} · child ${childSessionKey} · `
  if (!title.startsWith(prefix)) return localizeToolSummary(title, t, tool)
  let body = title.slice(prefix.length)
  const suffix = ` · ${reason}`
  const hasReason = body.endsWith(suffix)
  if (hasReason) body = body.slice(0, -suffix.length)
  return [
    t('approval.delegation.role', { role }),
    t('approval.delegation.child', { id: childSessionKey }),
    localizeToolSummary(body, t, tool),
    ...(hasReason
      ? [
          reason === 'Untrusted evidence (taint)'
            ? t('approval.delegation.taint')
            : localizeToolSummary(reason, t, tool),
        ]
      : []),
  ].join(' · ')
}

function leadingFirst(input: unknown): unknown {
  if (!isRecord(input)) return input
  const keys = Object.keys(input)
  const first = LEADING.filter((k) => keys.includes(k))
  return Object.fromEntries([...first, ...keys.filter((k) => !first.includes(k))].map((k) => [k, input[k]]))
}

function impactOf(tool: string | undefined, kind: unknown, input: unknown, t: Translate): string {
  const field = (name: string): string | undefined => {
    const v = isRecord(input) ? input[name] : undefined
    return typeof v === 'string' && v !== '' ? v : undefined
  }
  const path = field('path') ?? field('file_path')
  // 目标路径/网址直接拼进句子，中英文都写作「动词 + 空格 + 目标」，所以把空格放进插值值里。
  const target = (value: string | undefined): string => (value ? ` ${value}` : '')
  if (tool === 'exit_plan_mode') return t('app.approval.impact.plan')
  if (tool === 'write') return t('app.approval.impact.write', { target: target(path) })
  if (kind === 'edit') return t('app.approval.impact.edit', { target: target(path) })
  if (kind === 'execute') return t('app.approval.impact.execute')
  if (kind === 'fetch') return t('app.approval.impact.fetch', { target: target(field('url')) })
  if (kind === 'read')
    return path
      ? t('app.approval.impact.read', { target: target(path) })
      : t('app.approval.impact.readContent')
  return t('app.approval.impact.default')
}

export function liveApprovalCard(toolCall: Record<string, unknown>, t: Translate): ApprovalCard {
  const tool = approvalToolName(toolCall)
  const input = toolCall.rawInput
  if (
    tool === 'plugin_candidate_test' &&
    isRecord(input) &&
    typeof input.packageId === 'string' &&
    typeof input.candidateHash === 'string'
  )
    return {
      summary: t('app.approval.candidateTest', {
        name: input.packageId,
        hash: input.candidateHash.replace(/^sha256-/, '').slice(0, 12),
      }),
      impact: t('app.approval.candidateTestImpact'),
      preview: JSON.stringify(input, null, 2),
    }
  const impact = impactOf(tool, toolCall.kind, input, t)
  const title = typeof toolCall.title === 'string' ? toolCall.title.trim() : ''
  const humanTitle = title && (!tool || (title !== tool && !title.startsWith(`${tool} `))) ? title : undefined
  const delegated = approvalIsDelegated(toolCall)
  const summary =
    delegated && humanTitle
      ? delegatedSummary(toolCall, humanTitle, t, tool)
      : isRecord(input) && typeof input.description === 'string' && input.description.trim()
        ? [baseToolTitle(tool ?? '', t), input.description].filter(Boolean).join(' · ')
        : (humanTitle ? localizeToolSummary(humanTitle, t, tool) : baseToolTitle(tool ?? '', t)) || impact
  const sessionLabel = delegated ? undefined : t('app.approval.session.tool')
  if (input === undefined) return { summary, impact, ...(sessionLabel ? { sessionLabel } : {}) }
  const text = JSON.stringify(leadingFirst(input), null, 2) ?? String(input)
  if (tool === 'exit_plan_mode' || text.length <= PREVIEW_LIMIT)
    return { summary, impact, preview: text, ...(sessionLabel ? { sessionLabel } : {}) }
  let shown = PREVIEW_LIMIT
  const last = text.charCodeAt(shown - 1)
  if (last >= 0xd800 && last <= 0xdbff) shown -= 1
  const count = t('app.approval.truncatedCount', { shown, total: text.length })
  return {
    summary,
    impact,
    preview: `${text.slice(0, shown)}\n…[${count}]`,
    warning: t('app.approval.truncatedWarning', { count }),
  }
}
