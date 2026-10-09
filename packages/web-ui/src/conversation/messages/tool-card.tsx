import { type ReactNode, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { Translate } from '../../locales/index.js'
import { interactionToolPresentation } from '../interaction-result.js'
import { useInteractionSnapshot } from '../markdown-snapshot.js'
import { type ToolNode, fallbackT } from './context.js'

// A shell result ends with `[exit N]`. When the projection marks that call failed, N says why: a
// nonzero exit is the command's own answer, and what it printed is its output, not an error report.
// A result cut before its last line has no marker and keeps the general wording.
export const SHELL_EXIT = /\n?\[exit (-?\d+)\](?: \[output truncated by sandbox\])?\s*$/

/** How a tool call's outcome is named and its result introduced, for the card and its detail. */
export function toolOutcome(
  node: ToolNode,
  t: Translate = fallbackT,
): { label: string; section: string; text: string | undefined } {
  const preview = node.resultPreview
  const exit =
    node.name === 'shell' && node.status === 'failed' && preview !== undefined
      ? SHELL_EXIT.exec(preview)
      : null
  if (exit && preview !== undefined)
    return {
      label: t('tool.status.exitCode', { code: Number(exit[1]) }),
      section: t('tool.detail.result'),
      text: preview.slice(0, exit.index).trimEnd() || t('tool.detail.noOutput'),
    }
  return {
    label: t(toolLabelKeys[node.status]),
    section: t(node.status === 'failed' ? 'tool.detail.error' : 'tool.detail.result'),
    text: preview,
  }
}

export const toolLabelKeys: Record<ToolNode['status'], string> = {
  planned: 'tool.status.planned',
  awaiting_approval: 'tool.status.awaitingApproval',
  running: 'tool.status.running',
  completed: 'tool.status.completed',
  failed: 'tool.status.failed',
  cancelled: 'tool.status.cancelled',
}

export function ConversationToolCard({
  node,
  icon,
  onExpandedChange,
  presentation,
  resultAppendix,
  t = fallbackT,
}: {
  node: ToolNode
  icon?: ReactNode
  onExpandedChange?: (expanded: boolean) => void
  presentation?: { name: string; summary: string } | undefined
  resultAppendix?: string | undefined
  t?: Translate
}) {
  const [expanded, setExpanded] = useState(false)
  const cardHost = useRef<HTMLDivElement>(null)
  const detailHost = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const article = cardHost.current?.closest<HTMLElement>('.timeline-node.tool')
    if (article && (expanded || article.dataset.expanded !== undefined))
      article.dataset.expanded = String(expanded)
  }, [expanded])
  const interaction = presentation ?? interactionToolPresentation(node, t)
  const summary = interaction?.summary ?? node.summary.trim()
  const remainder = summary.startsWith(node.name) ? summary.slice(node.name.length).trim() : summary
  const meaningful =
    summary && summary !== node.name && remainder && !remainder.startsWith('{') && !remainder.startsWith('[')
  const outcome = toolOutcome(node, t)
  const nextDetail = [
    t('tool.detail.header', { name: node.name }),
    t('tool.detail.status', { status: outcome.label }),
    ...(node.argsPreview ? ['', t('tool.detail.args'), node.argsPreview] : []),
    ...(outcome.text ? ['', outcome.section, outcome.text] : []),
    ...(resultAppendix ? ['', resultAppendix] : []),
  ].join('\n')
  const detail = useInteractionSnapshot(detailHost, nextDetail)
  return (
    <div
      ref={cardHost}
      data-agnes-tool-card=""
      data-status={node.status}
      data-expanded={expanded ? 'true' : undefined}
    >
      <div className="tool-head">
        <div className="tool-meta">
          {icon}
          <span className="tool-name">{interaction?.name ?? node.name}</span>
          <span className="tool-status">{outcome.label}</span>
        </div>
        <button
          type="button"
          className="tool-detail"
          data-testid="tool-detail-toggle"
          aria-expanded={expanded}
          onClick={() => {
            const next = !expanded
            onExpandedChange?.(next)
            flushSync(() => setExpanded(next))
          }}
        >
          {expanded ? t('tool.detail.collapse') : t('tool.detail.expand')}
        </button>
      </div>
      <div className="tool-summary" hidden={!meaningful}>
        {meaningful ? summary : ''}
      </div>
      <div className="tool-detail-body" aria-hidden={!expanded}>
        <div className="tool-detail-inner">
          <div
            ref={detailHost}
            className="tool-detail-text"
            data-testid="tool-detail-text"
            tabIndex={expanded ? 0 : -1}
          >
            {detail}
          </div>
        </div>
      </div>
    </div>
  )
}
