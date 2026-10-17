import type { UITimeline, UITurnCall } from '@agnes/protocol'

export const categories = ['primary', 'summary', 'reviewer', 'side-call', 'child', 'other'] as const
export type Category = (typeof categories)[number]
const category = (purpose: string): Category => {
  if (purpose === 'inference') return 'primary'
  if (purpose === 'compaction') return 'summary'
  if (purpose === 'verifier' || purpose === 'approval-guardian') return 'reviewer'
  if (purpose === 'subagent') return 'child'
  return purpose === 'side-call' ? 'side-call' : 'other'
}

type DisplayTimeline = Pick<UITimeline, 'sessionId' | 'upto' | 'nodes' | 'usage'> &
  Partial<Pick<UITimeline, 'turns'>>
/** A derived display, never a billing authority. Always replace it from a stable SDK cut. */
export function usageSnapshot(timeline: DisplayTimeline) {
  const seen = new Set<string>()
  const covered = new Set<number>()
  const originals: UITurnCall[] = []
  const adjustments: UITurnCall[] = []
  for (const turn of timeline.turns ?? []) {
    for (const call of turn.usage.calls) {
      covered.add(call.seq)
      if (turn.inherited || seen.has(call.id)) continue
      seen.add(call.id)
      if (call.adjustment) adjustments.push(call)
      else originals.push(structuredClone(call))
    }
  }
  const bySeq = new Map(originals.map((call) => [call.seq, call]))
  let unlinked = 0
  for (const call of adjustments) {
    const adjustment = call.adjustment
    const original = adjustment && bySeq.get(adjustment.of)
    if (!original || !adjustment) {
      unlinked++
      continue
    }
    // Missing billing remains unknown. Credits are never converted into dollars.
    if (original.billing && adjustment.usdMicrosDelta !== undefined)
      original.billing.usdMicros += adjustment.usdMicrosDelta
    if (original.credits !== undefined) original.credits += adjustment.delta
  }
  const unattributed =
    new Set(
      timeline.nodes.filter((node) => node.kind === 'cost' && !covered.has(node.seq)).map((node) => node.id),
    ).size + unlinked
  const billed = (source: 'gateway' | 'estimated') => {
    const calls = originals.filter((row) => row.billing?.source === source)
    return calls.length ? calls.reduce((sum, row) => sum + (row.billing?.usdMicros ?? 0), 0) : undefined
  }
  return {
    sessionId: timeline.sessionId,
    upto: timeline.upto,
    // Core owns request/effect dedup, cumulative provider usage and fork boundaries. Never
    // add the per-call display to this total or infer a whole task tree from a parent row.
    usage: timeline.usage,
    groups: categories.map((name) => ({
      name,
      rows: originals.filter((row) => category(row.purpose) === name),
    })),
    observed: {
      actual: billed('gateway'),
      estimated: billed('estimated'),
      unknown: originals.filter((row) => !row.billing).length,
      unattributed,
      adjustments: adjustments.length - unlinked,
    },
  }
}

/** Only the selected session's existing authenticated projection is read. No child traversal. */
export class SelectedUsage {
  private epoch = 0
  private disposed = false
  async read(sessionId: string, read: () => Promise<UITimeline>) {
    if (this.disposed) return undefined
    const epoch = ++this.epoch
    const timeline = await read()
    if (this.disposed || epoch !== this.epoch) return undefined
    if (timeline.sessionId !== sessionId) throw new Error('Session selection changed')
    return usageSnapshot(timeline)
  }
  invalidate() {
    this.epoch++
  }
  dispose() {
    this.disposed = true
    this.invalidate()
  }
}
