import type { CostLedger, EventEnvelope, UINode, UITurn, UITurnCall, UITurnUsage } from '@agnes/protocol'
import { createTraceState, hydrateTraceState, type TraceFoldState, traceFold } from './trace.js'

type TurnEndReason = NonNullable<UITurn['reason']>

const emptyTotals = (): UITurnUsage['totals'] => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
})

const emptyUsage = (): UITurnUsage => ({
  totals: emptyTotals(),
  reasoningComplete: false,
  billingComplete: false,
  calls: [],
})

const statusFor = (reason: TurnEndReason): UITurn['status'] => {
  if (reason === 'completed') return 'completed'
  if (reason === 'aborted' || reason === 'interrupted') return 'cancelled'
  if (reason === 'parked') return 'waiting'
  return 'failed'
}

/**
 * A turn's usage, summed one call at a time: adding a call touches only that call, so a turn with many
 * calls costs the same per call as a short one. `view` reads the sums out in the shape the turn keeps.
 */
class UsageSum {
  private readonly totals = emptyTotals()
  private credits = 0
  private usdMicros = 0
  private hasCredits = false
  private hasBilling = false
  private originals = 0
  private creditsComplete = true
  private billingComplete = true
  private creditsGateway = true
  private billingGateway = true
  private subscription = true
  private reasoningComplete = true

  add(call: UITurnCall): void {
    if (call.adjustment) {
      this.credits += call.adjustment.delta
      this.usdMicros += call.adjustment.usdMicrosDelta ?? 0
      return
    }
    this.originals++
    const tokens = call.tokens
    if (tokens) {
      this.totals.input += tokens.input
      this.totals.output += tokens.output
      this.totals.cacheRead += tokens.cacheRead
      this.totals.cacheWrite += tokens.cacheWrite
      this.totals.reasoning += tokens.reasoning ?? 0
      this.reasoningComplete &&= tokens.reasoning !== undefined
    } else this.reasoningComplete = false
    if (call.credits !== undefined) {
      this.hasCredits = true
      this.credits += call.credits
      this.creditsGateway &&= call.creditSource === 'gateway'
    } else this.creditsComplete = false
    if (call.billing) {
      this.hasBilling = true
      this.usdMicros += call.billing.usdMicros
      this.billingGateway &&= call.billing.source === 'gateway'
      this.subscription &&= call.billing.subscription
    } else this.billingComplete = false
  }

  view(calls: UITurnCall[]): UITurnUsage {
    // Every completeness flag needs at least one call that is not an adjustment to stand on.
    const any = this.originals > 0
    const creditsComplete = any && this.creditsComplete
    const billingComplete = any && this.billingComplete
    return {
      totals: { ...this.totals },
      ...(this.hasCredits
        ? {
            credits: {
              amount: Math.max(0, this.credits),
              source: this.creditsGateway && creditsComplete ? ('gateway' as const) : ('estimated' as const),
              complete: creditsComplete,
            },
          }
        : {}),
      ...(this.hasBilling
        ? {
            cost: {
              usdMicros: Math.max(0, this.usdMicros),
              source: this.billingGateway && billingComplete ? ('gateway' as const) : ('estimated' as const),
              subscription: this.subscription,
            },
          }
        : {}),
      reasoningComplete: any && this.reasoningComplete,
      billingComplete: this.hasBilling && billingComplete,
      calls,
    }
  }
}

const callFrom = (event: EventEnvelope, row: CostLedger): UITurnCall => ({
  id: row.effectId,
  seq: event.seq,
  purpose: row.purpose,
  model: row.model,
  creditSource: row.creditSource,
  ...(!row.adjustment ? { tokens: structuredClone(row.tokens) } : {}),
  ...(row.credits !== undefined ? { credits: row.credits } : {}),
  ...(row.billing ? { billing: structuredClone(row.billing) } : {}),
  ...(row.interrupted !== undefined ? { interrupted: row.interrupted } : {}),
  ...(row.timing
    ? {
        timing: {
          ...(typeof row.timing.ttftMs === 'number' ? { ttftMs: row.timing.ttftMs } : {}),
          ...(typeof row.timing.durationMs === 'number' ? { durationMs: row.timing.durationMs } : {}),
        },
      }
    : {}),
  ...(row.adjustment ? { adjustment: structuredClone(row.adjustment) } : {}),
})

/** Stable turn ownership and billing derived only from committed ledger rows. */
export class TurnProjection {
  private readonly values: UITurn[] = []
  private readonly byId = new Map<string, UITurn>()
  private readonly physicalTurns = new Map<number, string>()
  private readonly effectTurns = new Map<string, string>()
  private readonly costTurns = new Map<number, string>()
  private readonly requestModels = new Map<number, string>()
  private readonly assistantRows = new Map<number, { id: string; model?: string }>()
  private pendingNodes: string[] = []
  private current: string | undefined
  private readonly traces = new Map<string, TraceFoldState>()
  private readonly traceFailed = new Set<string>()
  // Per turn: the running usage sum and the effect ids already counted, built from the turn's calls
  // the first time they are needed (a turn restored from a checkpoint arrives with calls already).
  private readonly usageSums = new Map<string, { sum: UsageSum; counted: Set<string> }>()

  get turns(): readonly UITurn[] {
    return this.values
  }

  apply(event: EventEnvelope): { changed: Set<string>; owner?: string } {
    const changed = new Set<string>()
    let owner = this.current
    const data = event.data as Record<string, unknown> | null
    switch (event.type) {
      case 'session/start': {
        if (data?.parent) {
          for (const turn of this.values) {
            if (turn.inherited) continue
            turn.inherited = true
            changed.add(turn.id)
          }
        }
        break
      }
      case 'turn/start': {
        const number = Number(data?.turn)
        const continued = (data?.continues as { turn?: unknown } | undefined)?.turn
        const continuedId =
          data?.trigger === 'approval-resume' && typeof continued === 'number'
            ? this.physicalTurns.get(continued)
            : undefined
        if (continuedId) {
          const turn = this.byId.get(continuedId)
          if (!turn) throw new TypeError(`missing continued UI turn ${continued}`)
          this.physicalTurns.set(number, continuedId)
          turn.status = 'running'
          turn.forkable = false
          delete turn.endSeq
          delete turn.endedAt
          delete turn.durationMs
          delete turn.reason
          this.current = continuedId
          owner = continuedId
          changed.add(continuedId)
          break
        }
        const id = `turn:${number}`
        if (this.byId.has(id)) throw new TypeError(`duplicate UI turn ${number}`)
        const turn: UITurn = {
          id,
          turn: number,
          startSeq: event.seq,
          startedAt: event.ts,
          status: 'running',
          nodeIds: [...this.pendingNodes],
          usage: emptyUsage(),
          inherited: false,
          forkable: false,
        }
        this.pendingNodes = []
        this.values.push(turn)
        this.byId.set(id, turn)
        this.physicalTurns.set(number, id)
        this.current = id
        owner = id
        changed.add(id)
        break
      }
      case 'turn/end': {
        const turn = this.current ? this.byId.get(this.current) : undefined
        if (!turn) break
        const reason = data?.reason as TurnEndReason
        turn.endSeq = event.seq
        turn.endedAt = event.ts
        const start = Date.parse(turn.startedAt)
        const end = Date.parse(event.ts)
        if (Number.isFinite(start) && Number.isFinite(end) && end >= start) turn.durationMs = end - start
        turn.reason = reason
        turn.status = statusFor(reason)
        turn.forkable = reason === 'completed'
        const finalSeq = data?.lastAssistantSeq
        const final = typeof finalSeq === 'number' ? this.assistantRows.get(finalSeq) : undefined
        if (final) {
          turn.finalAssistantId = final.id
          if (final.model) turn.finalModel = final.model
        }
        owner = turn.id
        changed.add(turn.id)
        this.current = undefined
        break
      }
      case 'effect/intent': {
        const effectId = data?.effectId
        if (typeof effectId === 'string' && this.current) this.effectTurns.set(effectId, this.current)
        break
      }
      case 'request/header': {
        const model = data?.model
        if (typeof model === 'string') this.requestModels.set(event.seq, model)
        break
      }
      case 'cost/ledger': {
        const row = event.data as CostLedger
        const target = row.adjustment
          ? this.costTurns.get(row.adjustment.of)
          : row.purpose === 'title'
            ? this.physicalTurns.get(row.sourceTurn ?? -1)
            : (this.effectTurns.get(row.effectId) ?? this.current)
        const turn = target ? this.byId.get(target) : undefined
        if (!turn) break
        const usage = this.usageOf(turn)
        if (usage.counted.has(row.effectId)) break
        const call = callFrom(event, row)
        turn.usage.calls.push(call)
        usage.counted.add(call.id)
        usage.sum.add(call)
        turn.usage = usage.sum.view(turn.usage.calls)
        if (!row.adjustment && row.purpose === 'inference' && turn.finalModel !== row.model)
          turn.finalModel = row.model
        this.costTurns.set(event.seq, turn.id)
        owner = turn.id
        changed.add(turn.id)
        break
      }
      case 'approval/asked': {
        const turn = this.current ? this.byId.get(this.current) : undefined
        if (turn && data?.pending) {
          turn.status = 'waiting'
          changed.add(turn.id)
        }
        break
      }
      case 'approval/decided': {
        const turn = this.current ? this.byId.get(this.current) : undefined
        if (turn && turn.status === 'waiting') {
          turn.status = 'running'
          changed.add(turn.id)
        }
        break
      }
    }
    this.applyTrace(event, owner)
    return { changed, ...(owner ? { owner } : {}) }
  }

  private usageOf(turn: UITurn): { sum: UsageSum; counted: Set<string> } {
    let usage = this.usageSums.get(turn.id)
    if (!usage) {
      usage = { sum: new UsageSum(), counted: new Set() }
      for (const call of turn.usage.calls) {
        usage.sum.add(call)
        usage.counted.add(call.id)
      }
      this.usageSums.set(turn.id, usage)
    }
    return usage
  }

  private applyTrace(event: EventEnvelope, owner: string | undefined): void {
    const turnId = owner ?? this.current
    if (!turnId || this.traceFailed.has(turnId)) return
    const turn = this.byId.get(turnId)
    if (!turn) return
    try {
      if (event.type === 'turn/start') {
        let state = this.traces.get(turnId)
        if (!state && turn.trace) {
          delete turn.trace.endSeq
          delete turn.trace.endedAt
          delete turn.trace.durationMs
          turn.trace.status = 'running'
          state = hydrateTraceState(turn.trace, turn.turn)
          this.traces.set(turnId, state)
        }
        if (!state) {
          state = createTraceState(turn.turn, event, turn.id)
          this.traces.set(turnId, state)
          turn.trace = state.root
        } else turn.trace = state.root
        return
      }
      const state = this.traces.get(turnId)
      if (!state || state.failed) return
      traceFold.applyTraceEvent(state, event)
      if (event.type === 'turn/end') {
        turn.trace = traceFold.closeTurnTrace(state, turn.reason, event)
        this.traces.delete(turnId)
      } else turn.trace = state.root
    } catch {
      this.traceFailed.add(turnId)
      this.traces.delete(turnId)
      delete turn.trace
    }
  }

  associate(event: EventEnvelope, nodeIds: Iterable<string>, owner?: string): Set<string> {
    const changed = new Set<string>()
    const ids = [...nodeIds]
    if (event.type === 'user/message' && !owner) {
      for (const id of ids) if (!this.pendingNodes.includes(id)) this.pendingNodes.push(id)
      return changed
    }
    const turn = owner ? this.byId.get(owner) : undefined
    if (turn) {
      for (const id of ids) if (!turn.nodeIds.includes(id)) turn.nodeIds.push(id)
      if (ids.length > 0) changed.add(turn.id)
    }
    if (event.type === 'assistant/message') {
      const message = event.data as { requestSeq?: number }
      const id = ids[0]
      if (id) {
        const model =
          message.requestSeq === undefined ? undefined : this.requestModels.get(message.requestSeq)
        this.assistantRows.set(event.seq, { id, ...(model ? { model } : {}) })
        const state = turn ? this.traces.get(turn.id) : undefined
        const generation = state?.lastGenerationId ? state.spans.get(state.lastGenerationId) : undefined
        if (turn && generation && !generation.nodeIds?.includes(id)) {
          generation.nodeIds = [...(generation.nodeIds ?? []), id]
          changed.add(turn.id)
        }
      }
    }
    if (event.type === 'tool/call' || event.type === 'tool/result') {
      const toolUseId = (event.data as { toolUseId?: string } | null)?.toolUseId
      const state = turn ? this.traces.get(turn.id) : undefined
      const spanId = toolUseId ? state?.toolToSpan.get(toolUseId) : undefined
      const span = spanId ? state?.spans.get(spanId) : undefined
      const nodeId = ids[0]
      if (span && nodeId && !span.nodeIds?.includes(nodeId)) {
        span.nodeIds = [...(span.nodeIds ?? []), nodeId]
        if (turn) changed.add(turn.id)
      }
    }
    return changed
  }
}

export function turnsForNodes(
  turns: readonly UITurn[],
  nodes: readonly UINode[],
  includeActive = true,
): UITurn[] {
  const ids = new Set(nodes.map((node) => node.id))
  return turns
    .filter(
      (turn) =>
        turn.nodeIds.some((id) => ids.has(id)) ||
        (includeActive && (turn.status === 'running' || turn.status === 'waiting')),
    )
    .map((turn) => structuredClone(turn))
}
