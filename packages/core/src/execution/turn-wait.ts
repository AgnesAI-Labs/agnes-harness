import type { Event, EventInput } from '@agnes/core-common/types'
import { scanAll } from '@agnes/core-ledger/log/scan-pages'
import type { SessionImpl } from '../step/session.js'

type TimingTotal = { count: number; ms: number; missing: number }

/** Sum recorded durations, not wall-clock turn latency: parallel tools can overlap. */
export function turnWaitSummary(rows: readonly Pick<Event, 'type' | 'data'>[]) {
  const model: TimingTotal = { count: 0, ms: 0, missing: 0 }
  const tools = new Map<string, TimingTotal>()
  const intents = new Map<string, { kind: string; tool?: { name: string } }>()
  const settled = new Map<string, number | undefined>()
  const costs = new Map<string, number | undefined>()
  for (const row of rows) {
    const data = row.data as {
      effectId: string
      kind: string
      tool?: { name: string }
      durationMs?: number
      timing?: { providerCallMs?: number; durationMs?: number }
    }
    if (row.type === 'effect/intent') intents.set(data.effectId, data)
    if (row.type === 'effect/settled') settled.set(data.effectId, data.durationMs)
    if (row.type === 'cost/ledger')
      costs.set(data.effectId, data.timing?.providerCallMs ?? data.timing?.durationMs)
  }
  const add = (total: TimingTotal, ms: number | undefined) => {
    total.count++
    if (ms === undefined) total.missing++
    else total.ms += ms
  }
  for (const [id, intent] of intents) {
    if (intent.kind === 'tool' && intent.tool) {
      const total = tools.get(intent.tool.name) ?? { count: 0, ms: 0, missing: 0 }
      add(total, settled.get(id))
      tools.set(intent.tool.name, total)
    } else if (costs.has(id) || intent.kind === 'inference' || intent.kind === 'side-call') {
      add(model, costs.get(id) ?? settled.get(id))
    }
  }
  return { model, tools: Array.from(tools, ([tool, total]) => ({ tool, ...total })) }
}

export async function turnWaitEvent(s: SessionImpl, pending: readonly EventInput[]) {
  const [start] = await s.scan({ type: 'turn/start', lane: s.lane, order: 'desc', limit: 1 })
  const rows = start
    ? await scanAll((query) => s.scan(query), {
        fromSeq: start.seq,
        toSeq: s.lastSeq,
        lane: s.lane,
        type: ['effect/intent', 'effect/settled', 'cost/ledger'],
      })
    : []
  return s.ev(
    'x/core/turn-wait',
    {
      turn: s.op()?.meta.turn ?? 0,
      ...turnWaitSummary([...rows, ...pending]),
    },
    { ignorable: true },
  )
}
