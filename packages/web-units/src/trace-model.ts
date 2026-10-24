import type { UINode, UISpan, UITurn } from '@agnes/protocol'
import type { SessionControlFact } from '@agnes/protocol/gen/agnes-v1'
import { type TraceMessageKey, traceLocale, traceText } from './trace-locale.js'
import type { TraceMetric, TraceTokenMetrics } from './trace-request-metrics.js'
import { summarizeTool, traceApprovalSummary } from './trace-summary.js'

export const BADGE_KEY: Record<string, TraceMessageKey> = {
  user: 'trace.badge.user',
  context: 'trace.badge.context',
  assistant: 'trace.badge.assistant',
  tool: 'trace.badge.tool',
  approval: 'trace.badge.approval',
  compaction: 'trace.badge.compaction',
  cost: 'trace.badge.cost',
  ui: 'trace.badge.ui',
  control: 'trace.badge.control',
}

const STATUS_KEY: Record<string, TraceMessageKey> = {
  running: 'trace.status.running',
  waiting: 'trace.status.waiting',
  completed: 'trace.status.completed',
  failed: 'trace.status.failed',
  cancelled: 'trace.status.cancelled',
  planned: 'trace.status.planned',
  awaiting_approval: 'trace.status.awaiting_approval',
}

/** One recorded state of a business-UI action or of something you did, in order. */
export type TraceRowStep = { label: string; at?: string | undefined; statusCode: string }

export type TraceRow = {
  /** What happened, in words: the inspector title. */
  title: string
  /** The list line; raw payloads stay out of it. */
  text: string
  /** Muted raw arguments, only when no readable summary exists. */
  secondary?: string | undefined
  tool?:
    | { name: string; toolUseId?: string; args?: string | undefined; result?: string | undefined }
    | undefined
  /** A business-UI view this row is about: its title and revision. */
  surface?: { title?: string | undefined; revision?: string | undefined; action?: boolean } | undefined
  steps?: readonly TraceRowStep[] | undefined
  /** Who did it, for your own actions. */
  actor?: string | undefined
  /** The answers you submitted through a business-UI view, field by field. */
  answers?: ReadonlyArray<readonly [string, string]> | undefined
  review?: import('@agnes/protocol').ToolReviewFact | undefined
  requestTraceId?: string | undefined
  id: string
  seq: number
  turn?: number | undefined
  step?: string | undefined
  kind: string
  badge: string
  statusCode: string
  preview: string
  raw: string
  rawNote?: string | undefined
  attachments?: readonly string[] | undefined
  source: string
  status: string
  errorCode?: string | undefined
  /** What the recorded failure said, when the span or the tool result carries it. */
  errorMessage?: string | undefined
  startedAt?: string | undefined
  durationMs?: number | undefined
  ttftMs?: number | undefined
  model?: string | undefined
  usage?: UITurn['usage'] | undefined
  callUsage?: UITurn['usage']['calls'][number] | undefined
}

export type { GanttBar, TimelineMode, TimelineRange } from './trace-gantt-model.js'
export const clip = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max).trimEnd()}…`

export const durationLabel = (duration?: number): string => {
  if (duration === undefined) return traceText('trace.duration.running')
  if (duration < 1000) return traceText('trace.duration.ms', { n: duration })
  if (duration < 60_000)
    return traceText('trace.duration.seconds', { n: (duration / 1000).toFixed(duration < 10_000 ? 1 : 0) })
  return traceText('trace.duration.minutes', {
    minutes: Math.floor(duration / 60_000),
    seconds: Math.round((duration % 60_000) / 1000),
  })
}

export const tokenLabel = (
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number },
  reasoningKnown: boolean,
): string =>
  traceText('trace.token.line', {
    input: tokens.input,
    output: tokens.output,
    cacheRead: tokens.cacheRead,
    cacheWrite: tokens.cacheWrite,
    reasoning: reasoningKnown ? (tokens.reasoning ?? '') : traceText('trace.token.unavailable'),
  })

export const metricLabel = (metric: TraceMetric<number>): string =>
  metric.state === 'known'
    ? String(metric.value)
    : metric.reason === 'earlier-history-unloaded'
      ? traceText('trace.metric.earlierUnloaded')
      : metric.reason === 'request-order-unverifiable'
        ? traceText('trace.metric.unverifiable')
        : traceText('trace.metric.unrecorded')

export const metricTokensLabel = (tokens: TraceTokenMetrics): string =>
  traceText('trace.token.line', {
    input: metricLabel(tokens.input),
    output: metricLabel(tokens.output),
    cacheRead: metricLabel(tokens.cacheRead),
    cacheWrite: metricLabel(tokens.cacheWrite),
    reasoning: metricLabel(tokens.reasoning),
  })

export const walkSpans = (span: UISpan, visit: (item: UISpan) => void): void => {
  visit(span)
  for (const child of span.children) walkSpans(child, visit)
}

type UserNode = Extract<UINode, { kind: 'user' }>

/**
 * A platform-written input (origin «system») is not something the person typed. A business-UI
 * answer is the person's own action; everything else is a system record. Each gets readable text
 * instead of the internal summary sent to the model.
 */
export function systemInputRow(node: UserNode):
  | {
      kind: 'control' | 'context'
      preview: string
      source: string
      answers?: Array<[string, string]>
    }
  | undefined {
  if (node.origin !== 'system' || !node.system) return undefined
  const system = node.system
  const presentation = system.presentation
  if (presentation?.kind === 'ui-action') {
    const submitted = (system.data as { submitted?: { answers?: unknown } } | null)?.submitted
    const answers =
      submitted?.answers && typeof submitted.answers === 'object' && !Array.isArray(submitted.answers)
        ? Object.keys(submitted.answers).length
        : presentation.fields.length
    const key: TraceMessageKey =
      presentation.status === 'rejected'
        ? 'trace.system.uiRejected'
        : presentation.status === 'failed'
          ? 'trace.system.uiFailed'
          : presentation.operation === 'submit' && answers > 0
            ? 'trace.system.uiAnswers'
            : 'trace.system.uiAction'
    const given =
      submitted?.answers && typeof submitted.answers === 'object' && !Array.isArray(submitted.answers)
        ? Object.entries(submitted.answers as Record<string, unknown>).map(
            ([field, value]): [string, string] => [
              field,
              Array.isArray(value)
                ? value.map(String).join(traceText('trace.join.items'))
                : typeof value === 'string'
                  ? value
                  : JSON.stringify(value),
            ],
          )
        : []
    return {
      kind: 'control',
      preview: traceText(key, { n: answers, label: presentation.label }),
      source: traceText('trace.source.yourUi'),
      ...(given.length ? { answers: given } : {}),
    }
  }
  if (presentation?.kind === 'child-completed')
    return {
      kind: 'context',
      preview: traceText('trace.system.child', {
        label: presentation.label,
        status: traceText(
          presentation.status === 'completed'
            ? 'trace.status.completed'
            : presentation.status === 'cancelled'
              ? 'trace.status.cancelled'
              : 'trace.status.failed',
        ),
      }),
      source: traceText('trace.source.system'),
    }
  if (system.source === 'agnes/deferred-invocations')
    return {
      kind: 'context',
      preview: traceText('trace.system.deferred'),
      source: traceText('trace.source.system'),
    }
  return {
    kind: 'context',
    preview: traceText('trace.system.other', { summary: system.summary }),
    source: traceText('trace.source.system'),
  }
}

const nodePreview = (node: UINode): string => {
  if (node.kind === 'user') {
    const system = systemInputRow(node)
    if (system) return system.preview
    const message = node.content
      .filter(
        (block): block is Extract<(typeof node.content)[number], { type: 'text' }> => block.type === 'text',
      )
      .map((block) => block.text)
      .join('\n')
    const images = node.content.filter((block) => block.type === 'image').length
    const resources = node.content.filter((block) => block.type === 'resource_link').length
    return [
      message,
      images ? traceText(images === 1 ? 'trace.preview.image' : 'trace.preview.images', { n: images }) : '',
      resources
        ? traceText(resources === 1 ? 'trace.preview.resource' : 'trace.preview.resources', { n: resources })
        : '',
    ]
      .filter(Boolean)
      .join(' · ')
  }
  if (node.kind === 'assistant') return node.text || node.thinking || ''
  if (node.kind === 'context') return node.text
  if (node.kind === 'tool') {
    const summary = node.summary && node.summary !== node.name ? ` · ${node.summary}` : ''
    const args = node.argsPreview ? ` ${node.argsPreview}` : ''
    const result = node.resultPreview ? ` → ${node.resultPreview}` : ''
    return `${node.name}${summary}${args}${result}`
  }
  if (node.kind === 'approval') return traceApprovalSummary(node)
  if (node.kind === 'compaction') return node.summary ?? ''
  if (node.kind === 'cost') return node.model ?? node.purpose ?? ''
  if (node.kind === 'artifact') return node.name
  return ''
}

const nodeRaw = (node: UINode): string => {
  if (node.kind === 'user' && node.origin === 'system' && node.system)
    return JSON.stringify(node.system, null, 2)
  if (node.kind === 'assistant') return [node.thinking, node.text].filter(Boolean).join('\n\n')
  if (node.kind === 'tool')
    return [
      traceText('trace.raw.tool', { name: node.name }),
      node.permissionDecision ? traceText('trace.approval.fullAccess') : undefined,
      node.argsPreview,
      node.resultPreview,
    ]
      .filter(Boolean)
      .join('\n\n')
  return nodePreview(node)
}

const userAttachments = (node: UINode): string[] => {
  if (node.kind !== 'user') return []
  return node.content.flatMap((block) => {
    if (block.type === 'image') return [traceText('trace.attachment.image', { mime: block.mimeType })]
    if (block.type === 'resource_link') {
      const name = `${block.name ?? traceText('trace.attachment.unnamed')}${block.mimeType ? ` · ${block.mimeType}` : ''}`
      return [traceText('trace.attachment.resource', { name })]
    }
    return []
  })
}

const nodeSource = (node: UINode): string => {
  if (node.kind === 'user' && systemInputRow(node)) return systemInputRow(node)?.source ?? ''
  if (node.kind === 'user')
    return node.actorLabel
      ? traceText('trace.source.userActor', { actor: node.actorLabel })
      : traceText('trace.source.user')
  if (node.kind === 'assistant') return traceText('trace.source.model')
  if (node.kind === 'tool') return traceText('trace.source.tool', { name: node.name })
  if (node.kind === 'context') return traceText('trace.source.context')
  if (node.kind === 'approval') return traceText('trace.source.approval')
  if (node.kind === 'compaction') return traceText('trace.source.compaction')
  return node.kind
}

/** «[runtime context] {json}» reads as its label and the facts a person would look for. */
export function contextLine(text: string): { label: string; detail: string } {
  const match = /^\[([^\]]+)\]\s*([\s\S]*)$/.exec(text.trim())
  if (!match) return { label: traceText('trace.badge.context'), detail: '' }
  const name = match[1] ?? ''
  const rest = match[2] ?? ''
  const label =
    name === 'runtime context'
      ? traceText('trace.context.runtime')
      : name === 'hook context'
        ? traceText('trace.context.hook')
        : name
  try {
    const value = JSON.parse(rest) as { environment?: Record<string, unknown> }
    const environment = value.environment
    if (environment && typeof environment === 'object') {
      const parts = [
        typeof environment.cwd === 'string' ? traceText('trace.context.cwd', { cwd: environment.cwd }) : '',
        typeof environment.model === 'string' ? environment.model : '',
      ].filter(Boolean)
      if (parts.length) return { label, detail: parts.join(' · ') }
    }
  } catch {}
  return { label, detail: '' }
}
const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim()

/** The list line and the inspector title for one recorded node. */
function describe(
  node: Exclude<UINode, { kind: 'slot' }>,
  preview: string,
  model: string | undefined,
): Pick<TraceRow, 'title' | 'text' | 'secondary'> {
  if (node.kind === 'tool') {
    const summary = summarizeTool(node)
    return { title: summary.text, text: summary.text, secondary: summary.secondary }
  }
  if (node.kind === 'context') {
    const line = contextLine(node.text)
    return { title: line.label, text: line.detail ? `${line.label} · ${line.detail}` : line.label }
  }
  if (node.kind === 'assistant')
    return {
      title: model ? traceText('trace.title.request', { model }) : traceText('trace.title.reply'),
      text: preview,
    }
  if (node.kind === 'user') {
    const system = systemInputRow(node)
    return { title: system ? system.preview : traceText('trace.title.user'), text: preview }
  }
  if (node.kind === 'approval')
    return {
      title:
        node.decision?.reason === 'full-access'
          ? traceText('trace.approval.fullAccess')
          : traceText('trace.title.approval', { summary: clip(preview, 60) }),
      text: preview,
    }
  if (node.kind === 'compaction') return { title: traceText('trace.title.compaction'), text: preview }
  return { title: preview, text: preview }
}

export const LIST_KINDS = new Set(['user', 'context', 'assistant', 'tool', 'approval', 'compaction'])

/** A span placed where the trace shortened a subtree; its message is how many steps it stands for. */
export const isTruncation = (span: UISpan): boolean => span.error?.code === 'TRACE_TRUNCATED'
export const truncationLabel = (span: UISpan): string => {
  const n = span.error?.message ?? traceText('trace.truncated.some')
  return traceText(n === '1' ? 'trace.truncated.one' : 'trace.truncated', { n })
}

type Placed = { span: UISpan; order: number; step: string | undefined }

/**
 * One pass over a snapshot. A node belongs to the first turn that lists it and to the span that
 * comes first in turn and depth-first order among those naming it by id or, for a tool node, by
 * tool use; nodes no turn lists fall back to the turn whose sequence range holds them.
 */
function indexTrace(turns: readonly UITurn[]) {
  const turnByNode = new Map<string, UITurn>()
  const spanByNode = new Map<string, Placed>()
  const spanByToolUse = new Map<string, Placed>()
  let order = 0
  for (const turn of turns) {
    for (const id of turn.nodeIds) if (!turnByNode.has(id)) turnByNode.set(id, turn)
    if (!turn.trace) continue
    const visit = (span: UISpan, step?: string): void => {
      const currentStep = span.kind === 'step' ? span.name : step
      const placed = { span, order: order++, step: currentStep }
      for (const id of span.nodeIds ?? []) if (!spanByNode.has(id)) spanByNode.set(id, placed)
      if (span.toolUseId && !spanByToolUse.has(span.toolUseId)) spanByToolUse.set(span.toolUseId, placed)
      for (const child of span.children) visit(child, currentStep)
    }
    visit(turn.trace)
  }
  return {
    turnFor(node: Exclude<UINode, { kind: 'slot' }>): UITurn | undefined {
      return (
        turnByNode.get(node.id) ??
        turns.find(
          (turn) => node.seq >= turn.startSeq && (turn.endSeq === undefined || node.seq <= turn.endSeq),
        )
      )
    },
    spanFor(node: UINode): Placed | undefined {
      const byId = spanByNode.get(node.id)
      const byTool = node.kind === 'tool' ? spanByToolUse.get(node.toolUseId) : undefined
      if (!byTool) return byId
      return !byId || byTool.order < byId.order ? byTool : byId
    },
  }
}

// A row depends only on its node, turn and span; unchanged objects are reused across snapshots.
const rowCache = new WeakMap<
  UINode,
  { locale: string; turn: UITurn | undefined; span: UISpan | undefined; row: TraceRow }
>()

export function buildTraceRows(nodes: readonly UINode[], turns: readonly UITurn[]): TraceRow[] {
  const index = indexTrace(turns)
  const rows: TraceRow[] = []
  for (const node of nodes) {
    if (node.kind === 'slot' || !LIST_KINDS.has(node.kind)) continue
    const turn = index.turnFor(node)
    const placed = index.spanFor(node)
    const span = placed?.span
    const preview = nodePreview(node).replace(/\s+/g, ' ').trim()
    const raw = nodeRaw(node)
    const attachments = userAttachments(node)
    const statusCode = node.kind === 'tool' ? node.status : (span?.status ?? 'completed')
    const status = traceText(STATUS_KEY[statusCode] ?? 'trace.status.completed')
    const errorCode = span && !isTruncation(span) ? span.error?.code : undefined
    const errorMessage =
      span && !isTruncation(span) && span.error?.message
        ? span.error.message
        : node.kind === 'tool' && node.status === 'failed'
          ? node.resultPreview
          : undefined
    const kind = (node.kind === 'user' ? systemInputRow(node)?.kind : undefined) ?? node.kind
    const usage = turn?.usage?.calls.length ? turn.usage : undefined
    const callUsage =
      span?.callSeq === undefined
        ? undefined
        : turn?.usage?.calls.find((call) => call.seq === span.callSeq && !call.adjustment)
    const locale = traceLocale()
    const cached = rowCache.get(node)
    if (
      cached &&
      cached.locale === locale &&
      cached.turn === turn &&
      cached.span === span &&
      cached.row.step === placed?.step &&
      cached.row.preview === preview &&
      cached.row.raw === raw &&
      (cached.row.attachments ?? []).join('\u0000') === attachments.join('\u0000') &&
      cached.row.status === status &&
      cached.row.startedAt === span?.startedAt &&
      cached.row.durationMs === span?.durationMs &&
      cached.row.ttftMs === span?.ttftMs &&
      cached.row.errorCode === errorCode &&
      cached.row.errorMessage === errorMessage &&
      cached.row.kind === kind &&
      cached.row.usage === usage &&
      cached.row.callUsage === callUsage &&
      cached.row.requestTraceId === span?.requestTraceId &&
      cached.row.review === span?.review &&
      cached.row.model === span?.model
    ) {
      rows.push(cached.row)
      continue
    }
    const row: TraceRow = {
      id: node.id,
      seq: node.seq,
      turn: turn?.turn,
      step: placed?.step,
      kind,
      badge: traceText(BADGE_KEY[kind] ?? 'trace.badge.assistant'),
      ...describe(node, preview, span?.model),
      ...(node.kind === 'tool'
        ? {
            tool: {
              name: node.name,
              toolUseId: node.toolUseId,
              args: node.argsPreview,
              result: node.resultPreview,
            },
          }
        : {}),
      ...(node.kind === 'user' && systemInputRow(node)?.answers
        ? { answers: systemInputRow(node)?.answers }
        : {}),
      preview,
      raw,
      ...(attachments.length ? { attachments, rawNote: traceText('trace.note.attachments') } : {}),
      source: nodeSource(node),
      status,
      statusCode,
      startedAt: span?.startedAt,
      durationMs: span?.durationMs,
      ttftMs: span?.ttftMs,
      model: span?.model,
      errorCode,
      ...(errorMessage ? { errorMessage } : {}),
      usage,
      callUsage,
      requestTraceId: span?.requestTraceId,
      review: span?.review,
    }
    rowCache.set(node, { locale, turn, span, row })
    rows.push(row)
  }
  rows.push(...uiFactRows(turns))
  return rows.sort((a, b) => a.seq - b.seq)
}

const UI_STATE_KEY = (state: string): TraceMessageKey => `trace.ui.${state}` as TraceMessageKey

/**
 * Business-UI facts the host adds to a turn's trace («action.received · r1», «surface.opened · r1 ·
 * Questions»). A view opening, changing or closing is one row; one action, from received to its
 * outcome, is one row whose steps keep each recorded state and time.
 */
function uiFactRows(turns: readonly UITurn[]): TraceRow[] {
  const facts: Array<{ span: UISpan; turn: number; state: string; revision?: string; title?: string }> = []
  for (const turn of turns)
    if (turn.trace)
      walkSpans(turn.trace, (span) => {
        if (span.kind !== 'other' || !span.id.startsWith('ui-fact:')) return
        const [state = '', revision, ...title] = span.name.split(' · ')
        facts.push({
          span,
          turn: turn.turn,
          state,
          ...(revision?.startsWith('r') ? { revision: revision.slice(1) } : {}),
          ...(title.length ? { title: title.join(' · ') } : {}),
        })
      })
  facts.sort((a, b) => a.span.startSeq - b.span.startSeq)
  const titleFor = (revision: string | undefined): string | undefined =>
    facts.find((fact) => fact.title && fact.revision === revision)?.title ??
    facts.find((fact) => fact.title)?.title
  const rows: TraceRow[] = []
  let open:
    | { row: TraceRow; revision: string | undefined; steps: TraceRowStep[]; spans: UISpan[] }
    | undefined
  for (const fact of facts) {
    const { span } = fact
    const label = traceText(UI_STATE_KEY(fact.state))
    const step = { label, at: span.startedAt, statusCode: span.status }
    const surface = fact.title ?? titleFor(fact.revision) ?? traceText('trace.ui.unknownSurface')
    const revision = fact.revision && fact.revision !== '?' ? fact.revision : undefined
    const line = [label, surface, revision ? traceText('trace.ui.revision', { n: revision }) : '']
      .filter(Boolean)
      .join(' · ')
    const base = {
      seq: span.startSeq,
      turn: fact.turn,
      kind: 'ui',
      badge: traceText('trace.badge.ui'),
      source: traceText('trace.source.uiPlugin'),
      startedAt: span.startedAt,
      surface: { title: surface, revision },
    }
    if (!fact.state.startsWith('action.')) {
      open = undefined
      rows.push({
        ...base,
        id: span.id,
        title: traceText('trace.ui.title.surface', { state: label, surface }),
        text: line,
        preview: line,
        raw: JSON.stringify(span, null, 2),
        status: traceText(STATUS_KEY[span.status] ?? 'trace.status.completed'),
        statusCode: span.status,
        durationMs: span.durationMs,
        steps: [step],
      })
      continue
    }
    if (!open || fact.state === 'action.received' || open.revision !== fact.revision) {
      const row: TraceRow = {
        ...base,
        id: span.id,
        title: traceText('trace.ui.title.action', { surface }),
        surface: { title: surface, revision, action: true },
        text: line,
        preview: line,
        raw: '',
        status: '',
        statusCode: span.status,
        steps: [],
      }
      open = { row, revision: fact.revision, steps: [], spans: [] }
      rows.push(row)
    }
    open.steps.push(step)
    open.spans.push(span)
    const first = Date.parse(open.steps[0]?.at ?? '')
    const last = Date.parse(span.startedAt)
    const failed = open.steps.some((item) => item.statusCode === 'failed')
    const statusCode = failed ? 'failed' : span.status
    Object.assign(open.row, {
      text: line,
      preview: line,
      statusCode,
      status: traceText(STATUS_KEY[statusCode] ?? 'trace.status.completed'),
      steps: [...open.steps],
      raw: JSON.stringify(open.spans, null, 2),
      ...(Number.isFinite(first) && Number.isFinite(last) ? { durationMs: Math.max(0, last - first) } : {}),
    })
  }
  return rows
}

const CONTROL_STATUS: Record<string, string> = {
  applied: 'completed',
  delivered: 'completed',
  withdrawn: 'cancelled',
  refused: 'failed',
  uncertain: 'waiting',
  requested: 'running',
  queued: 'waiting',
  edited: 'waiting',
}

/** The first text a person wrote inside a recorded control, such as a guidance message. */
function writtenText(value: unknown, depth = 0): string | undefined {
  if (depth > 5 || !value || typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = writtenText(item, depth + 1)
      if (found) return found
    }
    return undefined
  }
  const record = value as Record<string, unknown>
  if (typeof record.text === 'string' && record.text.trim()) return record.text
  for (const key of ['item', 'content', 'message', 'input', 'prompt']) {
    const found = writtenText(record[key], depth + 1)
    if (found) return found
  }
  return undefined
}

/**
 * The controls you used while the agent ran (guidance, pause, resume, cancel, interrupt, queued
 * message changes, subagent stop/continue), as rows of their own kind in the timeline. Facts about
 * one control (its admission or queued item) form one row whose steps are its recorded outcomes.
 */
export function buildControlRows(facts: readonly SessionControlFact[]): TraceRow[] {
  const groups = new Map<string, SessionControlFact[]>()
  for (const fact of [...facts].sort((a, b) => a.seq - b.seq)) {
    const details = (fact.details ?? {}) as Record<string, unknown>
    const id = details.itemId ?? details.admissionId
    const key = `${fact.action}:${typeof id === 'string' ? id : fact.seq}`
    groups.set(key, [...(groups.get(key) ?? []), fact])
  }
  return [...groups.values()].map((group) => {
    const first = group[0] as SessionControlFact
    const last = group.at(-1) as SessionControlFact
    const action = traceText(`trace.controls.${first.action}` as TraceMessageKey)
    const text = group.map((fact) => writtenText(fact.details)).find(Boolean)
    const title = !text
      ? action
      : first.action === 'steer'
        ? traceText('trace.control.title.steer', { text: clip(oneLine(text), 80) })
        : `${action} · ${clip(oneLine(text), 80)}`
    const statusCode = CONTROL_STATUS[last.outcome] ?? 'completed'
    const outcome = traceText(`trace.controls.${last.outcome}` as TraceMessageKey)
    return {
      id: `control:${first.seq}`,
      seq: first.seq,
      kind: 'control',
      badge: traceText('trace.badge.control'),
      title,
      text: `${title} · ${outcome}`,
      preview: `${title} · ${outcome}`,
      raw: JSON.stringify(group, null, 2),
      source: traceText('trace.control.you'),
      actor: first.actor.id,
      status: outcome,
      statusCode,
      startedAt: first.ts,
      steps: group.map((fact) => ({
        label: traceText(`trace.controls.${fact.outcome}` as TraceMessageKey),
        at: fact.ts,
        statusCode: CONTROL_STATUS[fact.outcome] ?? 'completed',
      })),
    }
  })
}

/**
 * Put each row under the turn that owns its place in the session. A turn owns the records from its
 * first input (a message waiting for it is listed in its nodeIds ahead of its start) up to the next
 * turn's first input. Records written between turns, such as a business-UI action answered after a
 * turn ended, stay with the turn they follow. Rows are already in sequence order, so every turn is
 * one contiguous run: a turn number recorded elsewhere (a UI fact's task id) cannot split the list
 * into alternating groups.
 */
export function placeTraceRowsInTurns(rows: readonly TraceRow[], turns: readonly UITurn[]): TraceRow[] {
  if (turns.length === 0) return [...rows]
  const seqById = new Map(rows.map((row) => [row.id, row.seq]))
  const ordered = [...turns].sort((a, b) => a.startSeq - b.startSeq)
  const opens: Array<{ seq: number; turn: number }> = []
  let previousStart = Number.NEGATIVE_INFINITY
  let previousOpen = Number.NEGATIVE_INFINITY
  for (const turn of ordered) {
    let open = turn.startSeq
    for (const id of turn.nodeIds) {
      const seq = seqById.get(id)
      if (seq !== undefined && seq < open && seq > previousStart) open = seq
    }
    open = Math.max(open, previousOpen)
    opens.push({ seq: open, turn: turn.turn })
    previousStart = turn.startSeq
    previousOpen = open
  }
  const owner = (seq: number): number | undefined => {
    let low = 0
    let high = opens.length
    while (low < high) {
      const middle = (low + high) >> 1
      if ((opens[middle]?.seq ?? 0) <= seq) low = middle + 1
      else high = middle
    }
    return low === 0 ? undefined : opens[low - 1]?.turn
  }
  return rows.map((row) => {
    const turn = owner(row.seq) ?? row.turn
    return turn === row.turn ? row : { ...row, turn }
  })
}

/** Called through this object so a test can count how often the list is rebuilt. */
export const traceRowBuilder = { build: buildTraceRows }

export const traceStats = (turns: readonly UITurn[]): Array<[string, string]> => {
  let calls = 0
  let duration = 0
  for (const turn of turns) {
    duration += turn.durationMs ?? turn.trace?.durationMs ?? 0
    if (turn.trace)
      walkSpans(turn.trace, (span) => {
        if (span.kind === 'generation' || span.kind === 'tool') calls += 1
      })
  }
  return [
    [traceText('trace.stat.duration'), durationLabel(duration)],
    [traceText('trace.stat.turns'), String(turns.length)],
    [traceText('trace.stat.calls'), String(calls)],
  ]
}

/** Localize conventional step numbers consistently in the list and inspector. */
export const traceStepLabel = (step: string | undefined): string | undefined => {
  const number = /^Step (\d+)$/i.exec(step ?? '')?.[1]
  return number ? traceText('trace.stepNumber', { n: number }) : step
}
