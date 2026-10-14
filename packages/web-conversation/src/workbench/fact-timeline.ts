import type {
  FactChainAnchor,
  FactChainNode,
  FactChainResult,
  UINode,
  UISpan,
  UITimeline,
  UITurnCall,
} from '@agnes/protocol'

/** One tone per kind of outcome; the tag's words say which outcome it is. */
export type ActivityTone = 'ok' | 'warn' | 'err' | 'mute' | 'brand'
export type ActivityStatus = { key: string; tone: ActivityTone }
export type ActivityRow = {
  /** The anchor's key when the row has one: deep links select the row by it. */
  key: string
  kind: 'request' | 'tool' | 'artifact'
  seq: number
  anchor?: FactChainAnchor
  /** Model id, tool name or artifact name. */
  name: string
  detail?: string
  status?: ActivityStatus
  durationMs?: number
  credits?: number
  startedAt?: string
  purpose?: UITurnCall['purpose']
  tokens?: { input: number; output: number }
  tool?: Extract<UINode, { kind: 'tool' }>
  artifact?: Extract<UINode, { kind: 'artifact' }>
}
export type ActivityTurn = {
  id: string
  turn: number
  startedAt: string
  prompt?: string
  rows: ActivityRow[]
}
export type ActivityFilter = 'all' | 'tools' | 'issues'

export function anchorKey(anchor: FactChainAnchor): string {
  if (anchor.kind === 'request') return `request:${anchor.callId}`
  if (anchor.kind === 'tool') return `tool:${anchor.toolUseId}`
  if (anchor.kind === 'artifact') return `artifact:${anchor.seq}`
  return `authoring:${anchor.candidateId}`
}

const TOOL_STATUS: Record<Extract<UINode, { kind: 'tool' }>['status'], ActivityStatus> = {
  planned: { key: 'facts.status.planned', tone: 'mute' },
  awaiting_approval: { key: 'facts.status.approval', tone: 'warn' },
  running: { key: 'facts.status.running', tone: 'brand' },
  completed: { key: 'facts.ok', tone: 'ok' },
  failed: { key: 'facts.errorResult', tone: 'err' },
  cancelled: { key: 'facts.aborted', tone: 'mute' },
}

/** The receipt is the settled fact; once it is read it replaces what the live timeline showed. */
export function receiptStatus(result: FactChainResult | undefined): ActivityStatus | undefined {
  const receipt = result?.nodes.find(
    (node): node is Extract<FactChainNode, { kind: 'receipt' }> => node.kind === 'receipt',
  )
  if (!receipt) return undefined
  if (receipt.resultKind === 'deferred-accepted') return { key: 'facts.deferredShort', tone: 'warn' }
  if (receipt.outcome === 'error') return { key: 'facts.errorResult', tone: 'err' }
  if (receipt.outcome === 'aborted') return { key: 'facts.aborted', tone: 'mute' }
  if (receipt.outcome === 'unknown') return { key: 'facts.unknown', tone: 'warn' }
  if (receipt.partial) return { key: 'facts.partial', tone: 'warn' }
  return { key: 'facts.ok', tone: 'ok' }
}

function spans(root: UISpan | undefined): UISpan[] {
  if (!root) return []
  const out: UISpan[] = []
  const stack = [root]
  while (stack.length) {
    const span = stack.pop() as UISpan
    out.push(span)
    stack.push(...span.children)
  }
  return out
}

function promptOf(node: UINode | undefined): string | undefined {
  if (node?.kind !== 'user') return undefined
  const text = node.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return undefined
  return text.length > 40 ? `${text.slice(0, 40)}…` : text
}

/**
 * The session's activity, turn by turn and newest turn first: each model request the turn paid for,
 * each tool call and each artifact it recorded, in ledger order. Built only from the live timeline;
 * the fact chain of a row is read when the row is opened.
 */
export function activityTimeline(timeline: UITimeline | undefined): ActivityTurn[] {
  if (!timeline) return []
  const nodes = new Map(timeline.nodes.map((node) => [node.id, node]))
  return [...timeline.turns]
    .sort((a, b) => b.startSeq - a.startSeq)
    .map((turn) => {
      const traced = spans(turn.trace)
      const byEffect = new Map(traced.flatMap((span) => (span.effectId ? [[span.effectId, span]] : [])))
      const byTool = new Map(
        traced.flatMap((span) => (span.kind === 'tool' && span.toolUseId ? [[span.toolUseId, span]] : [])),
      )
      const rows: ActivityRow[] = []
      let prompt: string | undefined
      for (const id of turn.nodeIds) {
        const node = nodes.get(id)
        if (!node) continue
        prompt ??= promptOf(node)
        if (node.kind === 'tool') {
          const span = byTool.get(node.toolUseId)
          const anchor = { kind: 'tool' as const, toolUseId: node.toolUseId }
          rows.push({
            key: anchorKey(anchor),
            kind: 'tool',
            seq: node.seq,
            anchor,
            name: node.name,
            ...(node.summary ? { detail: node.summary } : {}),
            status: TOOL_STATUS[node.status],
            ...(span?.durationMs !== undefined ? { durationMs: span.durationMs } : {}),
            ...(span?.startedAt ? { startedAt: span.startedAt } : {}),
            tool: node,
          })
        } else if (node.kind === 'artifact') {
          const anchor = { kind: 'artifact' as const, seq: node.seq, ref: node.ref }
          rows.push({
            key: anchorKey(anchor),
            kind: 'artifact',
            seq: node.seq,
            anchor,
            name: node.name,
            detail: node.ref.mime,
            artifact: node,
          })
        }
      }
      for (const call of turn.usage.calls) {
        if (call.adjustment) continue
        const span = byEffect.get(call.id)
        const anchor = span?.requestTraceId
          ? { kind: 'request' as const, callId: span.requestTraceId }
          : undefined
        rows.push({
          key: anchor ? anchorKey(anchor) : `call:${call.id}`,
          kind: 'request',
          seq: call.seq,
          ...(anchor ? { anchor } : {}),
          name: call.model,
          purpose: call.purpose,
          status: call.interrupted
            ? { key: 'facts.interrupted', tone: 'warn' }
            : { key: 'facts.ok', tone: 'ok' },
          ...(call.timing?.durationMs !== undefined ? { durationMs: call.timing.durationMs } : {}),
          ...(call.credits !== undefined ? { credits: call.credits } : {}),
          ...(span?.startedAt ? { startedAt: span.startedAt } : {}),
          ...(call.tokens ? { tokens: { input: call.tokens.input, output: call.tokens.output } } : {}),
        })
      }
      rows.sort((a, b) => a.seq - b.seq)
      return {
        id: turn.id,
        turn: turn.turn,
        startedAt: turn.startedAt,
        ...(prompt ? { prompt } : {}),
        rows,
      }
    })
    .filter((turn) => turn.rows.length > 0)
}

export function matchesFilter(row: ActivityRow, filter: ActivityFilter, settled?: ActivityStatus): boolean {
  if (filter === 'tools') return row.kind === 'tool'
  if (filter === 'issues') {
    const tone = (settled ?? row.status)?.tone
    return tone === 'err' || tone === 'warn'
  }
  return true
}

/** The file a write or edit call names, read from its own argument preview. */
export function changedPath(row: ActivityRow): string | undefined {
  const tool = row.tool
  if (!tool || (tool.name !== 'write' && tool.name !== 'edit') || !tool.argsPreview) return undefined
  try {
    const args: unknown = JSON.parse(tool.argsPreview)
    if (!args || typeof args !== 'object') return undefined
    const value = (args as Record<string, unknown>).path ?? (args as Record<string, unknown>).file_path
    return typeof value === 'string' && value ? value : undefined
  } catch {
    return undefined
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}
