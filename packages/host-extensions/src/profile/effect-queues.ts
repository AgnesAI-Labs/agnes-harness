import { rpcError } from '@agnes/protocol'

/** Reviewed urgent effects have their own bounded lane; callers cannot choose priority. */
export class ProfileEffectQueues {
  private readonly lanes = new Map<string, { tail: Promise<unknown>; depth: number }>()
  private total = 0
  async run<T>(
    owner: string,
    priority: 'normal' | 'urgent',
    signal: AbortSignal,
    work: () => Promise<T>,
  ): Promise<T> {
    const key = `${owner}:${priority}`
    const lane = this.lanes.get(key) ?? { tail: Promise.resolve(), depth: 0 }
    if (this.total >= 256 || lane.depth >= (priority === 'urgent' ? 8 : 32)) throw rpcError('OVERLOADED')
    this.lanes.set(key, lane)
    lane.depth++
    this.total++
    const pending = lane.tail.then(() => {
      signal.throwIfAborted()
      return work()
    })
    lane.tail = pending.catch(() => undefined)
    try {
      return await pending
    } finally {
      lane.depth--
      this.total--
      if (!lane.depth) this.lanes.delete(key)
    }
  }
}
