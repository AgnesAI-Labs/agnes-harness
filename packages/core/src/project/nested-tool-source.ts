import type { EventEnvelope } from '@agnes/protocol'

type Call = { seq: number; parent?: string; depth: number }
type Edge = { toolUseId: string; parentToolUseId: string; depth: number; running: boolean }
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/** Display-only causal binding. A tool's authored parentEffectId alone cannot create an edge. */
export class NestedToolSources {
  private readonly calls = new Map<string, Call>()
  private readonly roots = new Map<number, string>()
  private readonly edges = new Map<string, Edge>()
  private turn = 0
  private step = 0

  constructor(private sessionKey?: string) {}

  apply(event: EventEnvelope): Edge | undefined {
    const data = object(event.data)
    if (event.type === 'session/start' || event.type === 'turn/start' || event.type === 'step/start') {
      this.calls.clear()
      this.roots.clear()
      this.edges.clear()
      if (event.type === 'session/start') {
        this.turn = this.step = 0
        if (event.origin === 'system' && event.trust === 'trusted' && typeof data.key === 'string')
          this.sessionKey = data.key
      }
      if (typeof data.turn === 'number') this.turn = data.turn
      if (typeof data.step === 'number') this.step = data.step
      return
    }
    if (event.origin !== 'system' || event.trust !== 'trusted') return
    if (event.type === 'tool/call' && typeof data.toolUseId === 'string') {
      this.calls.set(data.toolUseId, {
        seq: event.seq,
        ...(typeof data.parentEffectId === 'string' ? { parent: data.parentEffectId } : {}),
        depth: typeof data.depth === 'number' ? data.depth : 0,
      })
      return
    }
    if (event.type === 'runtime/record') {
      const record = object(data.record)
      if (
        object(data.runtime).id === 'jevloop' &&
        record.kind === 'action.dispatching' &&
        typeof record.intentId === 'string' &&
        this.calls.has(record.intentId)
      )
        this.roots.set(event.seq, record.intentId)
      return
    }
    if (event.type !== 'x/host/jev-nested' || event.ignorable !== true) return
    const binding = object(data.binding)
    const childId = binding.toolUseId
    const parentId = binding.parentToolUseId
    if (typeof childId !== 'string' || typeof parentId !== 'string' || childId === parentId) return
    const child = this.calls.get(childId)
    const parent = this.calls.get(parentId)
    const parentEdge = this.edges.get(parentId)
    if (
      binding.version !== 1 ||
      (this.sessionKey !== undefined && binding.sessionKey !== this.sessionKey) ||
      binding.lane !== (event.lane ?? 'main') ||
      binding.turn !== this.turn ||
      binding.step !== this.step ||
      typeof binding.writerRunId !== 'string' ||
      !binding.writerRunId ||
      typeof binding.registryHash !== 'string' ||
      !binding.registryHash ||
      typeof binding.rootDispatchSeq !== 'number' ||
      this.roots.get(binding.rootDispatchSeq) !== binding.rootIntentId ||
      !child ||
      !parent ||
      child.parent !== parentId ||
      child.seq !== binding.callSeq ||
      parent.seq >= child.seq ||
      binding.rootDispatchSeq >= child.seq ||
      child.seq >= event.seq ||
      !event.sourceEventSeqs?.includes(child.seq) ||
      !event.sourceEventSeqs.includes(binding.rootDispatchSeq) ||
      binding.depth !== child.depth ||
      child.depth !== (parentEdge?.depth ?? 0) + 1 ||
      (parentId !== binding.rootIntentId && !parentEdge) ||
      (data.phase !== 'dispatching' && data.phase !== 'settled')
    )
      return
    const edge = {
      toolUseId: childId,
      parentToolUseId: parentId,
      depth: child.depth,
      running: data.phase === 'dispatching',
    }
    this.edges.set(childId, edge)
    return edge
  }
}
