// What the live approval card says about a tool call: what it will do, the arguments it will run with,
// and what the session-wide choice covers. Pure, so the wording and the "can everything be seen"
// rule are tested without a page.

import type { Translate } from './presentation.js'

/** Characters of the arguments the card prints. Past this the card says so and drops the session grant. */
export const PREVIEW_LIMIT = 32 * 1024

/** Argument names that say what a call acts on; they lead the preview whatever order they arrived in. */
const LEADING = ['plan', 'path', 'file_path', 'command', 'url', 'pattern', 'query']

export type ApprovalCard = {
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
  const impact = impactOf(tool, toolCall.kind, input, t)
  const sessionLabel = tool ? t('app.approval.session.all', { tool }) : t('app.approval.session.tool')
  if (input === undefined) return { impact, sessionLabel }
  const text = JSON.stringify(leadingFirst(input), null, 2) ?? String(input)
  if (text.length <= PREVIEW_LIMIT) return { impact, preview: text, sessionLabel }
  let shown = PREVIEW_LIMIT
  const last = text.charCodeAt(shown - 1)
  if (last >= 0xd800 && last <= 0xdbff) shown -= 1
  const count = t('app.approval.truncatedCount', { shown, total: text.length })
  return {
    impact,
    preview: `${text.slice(0, shown)}\n…[${count}]`,
    warning: t('app.approval.truncatedWarning', { count }),
  }
}
