import type { CostLedger, EventEnvelope, UISpan, UITurn, UITurnUsage } from '@agnes/protocol'
import { clipUtf16 as clip } from './clip.js'

export const SUBAGENT_TOOL_NAMES = new Set(['subagent_fork', 'subagent_spawn'])

export type TraceFoldState = {
  root: UISpan
  turn: number
  failed: boolean
  currentStepId?: string
  activeInference?: string
  lastGenerationId?: string
  spans: Map<string, UISpan>
  effectToSpan: Map<string, string>
  toolToSpan: Map<string, string>
  approvalToSpan: Map<string, string>
  toolParentEffect: Map<string, string>
}

const wallMs = (startedAt: string, endedAt: string): number | undefined => {
  const start = Date.parse(startedAt)
  const end = Date.parse(endedAt)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return
  return end - start
}

const spanStatusForTurn = (reason: string | undefined): UISpan['status'] => {
  if (reason === 'completed') return 'completed'
  if (reason === 'aborted' || reason === 'interrupted') return 'cancelled'
  if (reason === 'parked') return 'waiting'
  return 'failed'
}

function closeSpan(span: UISpan, event: EventEnvelope, status: UISpan['status'], durationMs?: number): void {
  if (span.endSeq !== undefined) return
  span.endSeq = event.seq
  span.endedAt = event.ts
  span.status = status
  const measured = durationMs ?? wallMs(span.startedAt, event.ts)
  if (measured !== undefined) span.durationMs = measured
}

function makeSpan(
  id: string,
  kind: UISpan['kind'],
  name: string,
  event: EventEnvelope,
  extra: Partial<UISpan> = {},
): UISpan {
  return {
    id: clip(id, 128),
    kind,
    name: clip(name, 256),
    status: 'running',
    startSeq: event.seq,
    startedAt: event.ts,
    children: [],
    ...extra,
  }
}

function register(state: TraceFoldState, span: UISpan): UISpan {
  state.spans.set(span.id, span)
  if (span.effectId) state.effectToSpan.set(span.effectId, span.id)
  if (span.kind === 'tool' && span.toolUseId) state.toolToSpan.set(span.toolUseId, span.id)
  return span
}

function ensureStep(state: TraceFoldState, event: EventEnvelope): UISpan {
  if (state.currentStepId) {
    const open = state.spans.get(state.currentStepId)
    if (open && open.endSeq === undefined) return open
  }
  const span = register(
    state,
    makeSpan(`span:step:${state.turn}:implicit:${event.seq}`, 'step', 'Step', event),
  )
  state.root.children.push(span)
  state.currentStepId = span.id
  return span
}

function ensureTool(
  state: TraceFoldState,
  event: EventEnvelope,
  toolUseId: string,
  name: string,
  parentEffectId?: string,
): UISpan {
  const existing = state.toolToSpan.get(toolUseId)
  if (existing) return state.spans.get(existing) ?? state.root
  let parent = ensureStep(state, event)
  if (parentEffectId) {
    const parentSpanId = state.effectToSpan.get(parentEffectId)
    const parentSpan = parentSpanId ? state.spans.get(parentSpanId) : undefined
    if (parentSpan) parent = parentSpan
  }
  const span = register(state, makeSpan(`span:tool:${toolUseId}`, 'tool', name, event, { toolUseId }))
  parent.children.push(span)
  if (SUBAGENT_TOOL_NAMES.has(name)) {
    const nested = register(state, makeSpan(`span:subagent:${toolUseId}`, 'subagent', name, event))
    span.children.push(nested)
  }
  return span
}

function walk(span: UISpan, visit: (item: UISpan) => void): void {
  visit(span)
  for (const child of span.children) walk(child, visit)
}

export function createTraceState(turn: number, event: EventEnvelope, turnId: string): TraceFoldState {
  const root = makeSpan(turnId, 'turn', `Turn ${turn}`, event)
  const spans = new Map<string, UISpan>([[root.id, root]])
  return {
    root,
    turn,
    failed: false,
    spans,
    effectToSpan: new Map(),
    toolToSpan: new Map(),
    approvalToSpan: new Map(),
    toolParentEffect: new Map(),
  }
}

export function hydrateTraceState(root: UISpan, turn: number): TraceFoldState {
  const state: TraceFoldState = {
    root,
    turn,
    failed: false,
    spans: new Map(),
    effectToSpan: new Map(),
    toolToSpan: new Map(),
    approvalToSpan: new Map(),
    toolParentEffect: new Map(),
  }
  walk(root, (span) => {
    state.spans.set(span.id, span)
    if (span.effectId) state.effectToSpan.set(span.effectId, span.id)
    if (span.toolUseId) state.toolToSpan.set(span.toolUseId, span.id)
    if (span.kind === 'step' && span.endSeq === undefined) state.currentStepId = span.id
    if (span.kind === 'generation') {
      state.lastGenerationId = span.id
      if (span.endSeq === undefined && span.effectId) state.activeInference = span.effectId
    }
  })
  return state
}

function applyTraceEventInner(state: TraceFoldState, event: EventEnvelope): void {
  const data = (event.data ?? {}) as Record<string, unknown>
  switch (event.type) {
    case 'step/start': {
      const step = Number(data.step)
      const span = register(
        state,
        makeSpan(
          `span:step:${state.turn}:${Number.isFinite(step) ? step : event.seq}`,
          'step',
          `Step ${Number.isFinite(step) ? step : ''}`.trim(),
          event,
        ),
      )
      state.root.children.push(span)
      state.currentStepId = span.id
      return
    }
    case 'step/end': {
      if (state.currentStepId) {
        const step = state.spans.get(state.currentStepId)
        if (step) closeSpan(step, event, 'completed')
      }
      return
    }
    case 'effect/intent': {
      const effectId = typeof data.effectId === 'string' ? data.effectId : undefined
      const kind = data.kind
      if (!effectId) return
      if (kind === 'inference') {
        const step = ensureStep(state, event)
        const span = register(
          state,
          makeSpan(`span:generation:${effectId}`, 'generation', 'model', event, {
            effectId,
            purpose: 'inference',
          }),
        )
        step.children.push(span)
        state.activeInference = effectId
        state.lastGenerationId = span.id
        return
      }
      if (kind === 'tool') {
        const tool = data.tool as { toolUseId?: string; name?: string } | undefined
        const toolUseId = tool?.toolUseId
        const name = tool?.name ?? 'tool'
        if (!toolUseId) return
        const parentEffectId = typeof data.parentEffectId === 'string' ? data.parentEffectId : undefined
        if (parentEffectId) state.toolParentEffect.set(effectId, parentEffectId)
        const span = ensureTool(state, event, toolUseId, name, parentEffectId)
        span.effectId = effectId
        state.effectToSpan.set(effectId, span.id)
        return
      }
      if (kind === 'compaction') {
        const span = register(
          state,
          makeSpan(`span:compaction:${effectId}`, 'compaction', 'compaction', event, {
            effectId,
            purpose: 'compaction',
          }),
        )
        const step = state.currentStepId ? state.spans.get(state.currentStepId) : undefined
        ;(step && step.endSeq === undefined ? step : state.root).children.push(span)
        return
      }
      if (kind === 'approval-guardian') {
        const span = register(
          state,
          makeSpan(`span:approval-guardian:${effectId}`, 'approval', 'approval guardian', event, {
            effectId,
            purpose: 'approval-guardian',
          }),
        )
        state.effectToSpan.set(effectId, span.id)
        ensureStep(state, event).children.push(span)
        return
      }
      return
    }
    case 'request/header': {
      const model = typeof data.model === 'string' ? data.model : undefined
      if (!model || !state.activeInference) return
      const id = state.effectToSpan.get(state.activeInference)
      const span = id ? state.spans.get(id) : undefined
      if (span) {
        span.model = clip(model, 256)
        span.name = clip(model, 256)
      }
      return
    }
    case 'tool/call': {
      const toolUseId = typeof data.toolUseId === 'string' ? data.toolUseId : undefined
      const name = typeof data.name === 'string' ? data.name : 'tool'
      if (!toolUseId) return
      const parentEffectId = state.activeInference
      ensureTool(state, event, toolUseId, name, parentEffectId)
      return
    }
    case 'approval/asked': {
      const requestId = typeof data.requestId === 'string' ? data.requestId : undefined
      if (!requestId) return
      const toolUseId = typeof data.toolUseId === 'string' ? data.toolUseId : undefined
      const parent = toolUseId ? state.spans.get(state.toolToSpan.get(toolUseId) ?? '') : undefined
      const span = register(
        state,
        makeSpan(`span:approval:${requestId}`, 'approval', 'approval', event, { status: 'waiting' }),
      )
      span.status = 'waiting'
      state.approvalToSpan.set(requestId, span.id)
      ;(parent ?? ensureStep(state, event)).children.push(span)
      return
    }
    case 'approval/decided': {
      const requestId = typeof data.requestId === 'string' ? data.requestId : undefined
      if (!requestId) return
      const span = state.spans.get(state.approvalToSpan.get(requestId) ?? '')
      const verdict = typeof data.verdict === 'string' ? data.verdict : ''
      const rejected = verdict === 'rejected' || verdict === 'cancelled'
      if (span) closeSpan(span, event, rejected ? 'failed' : 'completed')
      const toolUseId = typeof data.toolUseId === 'string' ? data.toolUseId : undefined
      if (rejected && toolUseId) {
        const tool = state.spans.get(state.toolToSpan.get(toolUseId) ?? '')
        if (tool) closeSpan(tool, event, 'failed')
      }
      return
    }
    case 'cost/ledger': {
      const row = event.data as CostLedger
      if (row.adjustment) return
      if (row.purpose === 'title') {
        const span = register(
          state,
          makeSpan(`span:generation:${row.effectId}`, 'generation', row.model || 'title', event, {
            effectId: row.effectId,
            purpose: 'title',
            model: clip(row.model, 256),
            callSeq: event.seq,
            ...(row.timing?.ttftMs !== undefined ? { ttftMs: row.timing.ttftMs } : {}),
          }),
        )
        closeSpan(span, event, row.interrupted ? 'failed' : 'completed', row.timing?.durationMs)
        state.root.children.push(span)
        return
      }
      const id = state.effectToSpan.get(row.effectId)
      const span = id ? state.spans.get(id) : undefined
      if (!span) return
      if (row.model) {
        span.model = clip(row.model, 256)
        if (span.kind === 'generation') span.name = clip(row.model, 256)
      }
      span.purpose = row.purpose
      span.callSeq = event.seq
      if (row.timing?.ttftMs !== undefined) span.ttftMs = row.timing.ttftMs
      const status = row.interrupted ? 'failed' : 'completed'
      closeSpan(span, event, status, row.timing?.durationMs)
      if (span.kind === 'generation' && state.activeInference === row.effectId) delete state.activeInference
      return
    }
    case 'effect/settled': {
      const effectId = typeof data.effectId === 'string' ? data.effectId : undefined
      if (!effectId) return
      const span = state.spans.get(state.effectToSpan.get(effectId) ?? '')
      if (!span || span.endSeq !== undefined) return
      const outcome = typeof data.outcome === 'string' ? data.outcome : 'ok'
      const status: UISpan['status'] =
        outcome === 'ok' ? 'completed' : outcome === 'aborted' ? 'cancelled' : 'failed'
      const durationMs = typeof data.durationMs === 'number' ? data.durationMs : undefined
      if (typeof data.code === 'string') span.error = { code: data.code }
      closeSpan(span, event, status, durationMs)
      if (span.kind === 'tool' && SUBAGENT_TOOL_NAMES.has(span.name) && span.name === 'subagent_fork') {
        const nested = span.children.find((child) => child.kind === 'subagent')
        if (nested) closeSpan(nested, event, status, durationMs)
      }
      return
    }
    case 'tool/result': {
      const toolUseId = typeof data.toolUseId === 'string' ? data.toolUseId : undefined
      if (!toolUseId) return
      const span = state.spans.get(state.toolToSpan.get(toolUseId) ?? '')
      if (!span) return
      const failed = data.isError === true
      if (span.endSeq === undefined) closeSpan(span, event, failed ? 'failed' : 'completed')
      else if (failed) span.status = 'failed'
      const structured = data.structured
      const childKey =
        structured &&
        typeof structured === 'object' &&
        !Array.isArray(structured) &&
        typeof (structured as { childKey?: unknown }).childKey === 'string'
          ? (structured as { childKey: string }).childKey
          : undefined
      const nested = span.children.find((child) => child.kind === 'subagent')
      if (nested && childKey) nested.childSessionKey = clip(childKey, 512)
      if (nested && span.name === 'subagent_fork' && nested.endSeq === undefined)
        closeSpan(nested, event, failed ? 'failed' : 'completed')
      return
    }
    case 'subagent/cost': {
      const childKey = typeof data.childKey === 'string' ? data.childKey : undefined
      if (!childKey) return
      for (const span of state.spans.values()) {
        if (span.kind !== 'subagent' || span.childSessionKey || span.endSeq !== undefined) continue
        span.childSessionKey = clip(childKey, 512)
        return
      }
      const open = [...state.spans.values()].filter(
        (span) => span.kind === 'subagent' && span.endSeq === undefined && !span.childSessionKey,
      )
      const only = open.length === 1 ? open[0] : undefined
      if (only) only.childSessionKey = clip(childKey, 512)
      return
    }
    default:
      return
  }
}

/** Fold one ledger event into a turn's span tree. Mutates `state`. */
export function applyTraceEvent(state: TraceFoldState, event: EventEnvelope): TraceFoldState {
  if (state.failed) return state
  applyTraceEventInner(state, event)
  return state
}

export function closeTurnTrace(
  state: TraceFoldState,
  reason: string | undefined,
  event: EventEnvelope,
): UISpan {
  const status = spanStatusForTurn(reason)
  walk(state.root, (span) => {
    if (span.kind === 'subagent' && span.name === 'subagent_spawn' && span.endSeq === undefined) return
    if (span.endSeq === undefined && span !== state.root) closeSpan(span, event, status)
  })
  closeSpan(state.root, event, status)
  return state.root
}

export function collectSubagentKeys(turns: readonly UITurn[]): string[] {
  const keys: string[] = []
  const seen = new Set<string>()
  const visit = (span: UISpan) => {
    if (span.kind === 'subagent' && span.childSessionKey && !seen.has(span.childSessionKey)) {
      seen.add(span.childSessionKey)
      keys.push(span.childSessionKey)
    }
    for (const child of span.children) visit(child)
  }
  for (const turn of turns ?? []) if (turn.trace) visit(turn.trace)
  return keys
}

export type TraceOwners = ReadonlyMap<string, { turnId: string; spanId: string }>

/**
 * The span each child's tree attaches to: the first subagent span naming it, turns in order,
 * depth first. This is the span attachChildTraces fills; later spans naming the same child stay as
 * the parent fold left them.
 */
export function subagentOwners(turns: readonly UITurn[]): TraceOwners {
  const owners = new Map<string, { turnId: string; spanId: string }>()
  const visit = (turnId: string, span: UISpan) => {
    if (span.kind === 'subagent' && span.childSessionKey) {
      if (!owners.has(span.childSessionKey)) owners.set(span.childSessionKey, { turnId, spanId: span.id })
      return
    }
    for (const child of span.children) visit(turnId, child)
  }
  for (const turn of turns) if (turn.trace) visit(turn.id, turn.trace)
  return owners
}

const attachInto = async (
  span: UISpan,
  load: (childKey: string) => Promise<UISpan[] | undefined>,
  visited: Set<string>,
): Promise<void> => {
  if (span.kind === 'subagent' && span.childSessionKey) {
    if (visited.has(span.childSessionKey)) return
    visited.add(span.childSessionKey)
    try {
      const nested = await load(span.childSessionKey)
      if (nested) span.children = nested
    } catch {
      span.children = []
    }
  }
  for (const child of span.children) await attachInto(child, load, visited)
}

export async function attachChildTraces(
  turns: UITurn[],
  load: (childKey: string) => Promise<UISpan[] | undefined>,
  parentUsageTotals: UITurnUsage['totals'],
): Promise<UITurn[]> {
  const visited = new Set<string>()
  for (const turn of turns) if (turn.trace) await attachInto(turn.trace, load, visited)
  void parentUsageTotals
  return turns
}

export const traceFold = { applyTraceEvent, closeTurnTrace, attachChildTraces }
