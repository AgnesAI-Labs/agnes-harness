import type { UITurn } from '@agnes/protocol'
import { type ReactNode, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useDocumentLanguage } from '../../document-language.js'
import type { Translate } from '../../locales/index.js'
import { interactionToolPresentation } from '../interaction-result.js'
import { useInteractionSnapshot } from '../markdown-snapshot.js'
import { ActivityRow, type ActivityState } from './activity-row.js'
import { fallbackT, type ToolNode } from './context.js'
import { shellOutput } from './shell-output.js'
import { ToolOutput } from './tool-output.js'
import { toolStep } from './tool-step.js'
import { WebSourceList, webSources } from './web-sources.js'

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

/** One step of a turn's process: a single line that opens the call's detail in place. */
export function ConversationToolCard({
  node,
  icon,
  onExpandedChange,
  presentation,
  resultAppendix,
  t = fallbackT,
  turnStatus,
}: {
  node: ToolNode
  icon?: ReactNode
  onExpandedChange?: (expanded: boolean) => void
  presentation?: { name: string; summary: string } | undefined
  resultAppendix?: string | undefined
  t?: Translate
  /** How the turn holding the call stands; a call still planned when the turn stopped never ran. */
  turnStatus?: UITurn['status'] | undefined
}) {
  const language = useDocumentLanguage()
  const delegatedTitle =
    node.delegatedRole?.title[language === 'zh-CN' ? 'zh-CN' : 'en'] ?? node.delegatedRole?.title.en
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
  // Declared in a step the turn did not carry out (it stopped, waits or moved on): it never ran.
  const notRun = node.status === 'planned' && turnStatus !== undefined && turnStatus !== 'running'
  const outcome = toolOutcome(node, t)
  const step = toolStep(node, t, interaction)
  const nextDetail = useMemo(() => {
    const output =
      node.name === 'shell' && node.status === 'completed'
        ? shellOutput(node.resultPreview)
        : { text: node.resultPreview }
    return { node, output, command: step.command, appendix: resultAppendix }
  }, [node, step.command, resultAppendix])
  const detail = useInteractionSnapshot(detailHost, nextDetail)
  const toggle = () => {
    const next = !expanded
    onExpandedChange?.(next)
    flushSync(() => setExpanded(next))
  }
  // A finished web search lists the pages it found; the raw text stays underneath.
  const sources = step.kind === 'web' && node.status === 'completed' ? webSources(outcome.text) : []
  const state: ActivityState =
    node.status === 'running'
      ? 'running'
      : node.status === 'failed'
        ? 'failed'
        : node.status === 'awaiting_approval'
          ? 'attention'
          : node.status === 'cancelled' || notRun
            ? 'cancelled'
            : undefined
  // Success is silent; only a step that failed, waits, was cancelled or never ran says so.
  const note = notRun
    ? t('tool.status.notRun')
    : state && state !== 'running'
      ? outcome.label
      : node.permissionDecision
        ? t('timeline.reason.fullAccess')
        : undefined
  const target = step.target || (meaningful && step.kind !== 'command' ? summary : '')
  return (
    <div
      ref={cardHost}
      data-agnes-tool-card=""
      data-status={node.status}
      {...(notRun ? { 'data-not-run': 'true' } : {})}
      data-expanded={expanded ? 'true' : undefined}
    >
      {delegatedTitle && (
        <p className="delegated-role-attribution" data-testid="delegated-role-attribution">
          {t('timeline.handledBy', { role: delegatedTitle })}
        </p>
      )}
      <ActivityRow
        className="tool-detail"
        testId="tool-detail-toggle"
        icon={icon}
        verb={<span className="tool-name">{step.verb}</span>}
        target={target}
        tooltip={step.full || target || (expanded ? t('tool.detail.collapse') : t('tool.detail.expand'))}
        mono={step.mono ?? false}
        state={state}
        note={note}
        expanded={expanded}
        onToggle={toggle}
      />
      <div className="tool-detail-body" aria-hidden={!expanded} hidden={!expanded}>
        <div className="tool-detail-inner">
          {sources.length > 0 && expanded && (
            <WebSourceList sources={sources} label={t('activity.sources', { n: sources.length })} />
          )}
          <ToolOutput
            host={detailHost}
            node={detail.node}
            command={detail.command}
            output={sources.length ? undefined : detail.output.text}
            environment={'environment' in detail.output ? detail.output.environment : undefined}
            appendix={detail.appendix}
            section={outcome.section}
            t={t}
          />
        </div>
      </div>
    </div>
  )
}
