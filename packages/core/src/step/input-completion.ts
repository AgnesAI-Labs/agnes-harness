import { scanAll } from '../log/scan-pages.js'
import type { ScanQuery } from '../log/storage.js'
import { CoreError } from '../types.js'

/** Run FIFO predecessors, but only report completion after this exact input was claimed.
 * Every continuation must advance the durable prefix; blocked/unknown/cancelled outcomes stop. */
export async function runInputToCompletion<T extends { reason: string; lastSeq: number }>(input: {
  itemId: string
  enqueuedSeq: number
  signal: AbortSignal
  read(query: ScanQuery): Promise<Array<{ seq: number; data: unknown; origin?: string; trust?: string }>>
  run(): Promise<T>
}): Promise<T> {
  let head = input.enqueuedSeq
  const sources = await input.read({ type: 'inbox', fromSeq: head, toSeq: head, limit: 1 })
  const initial = sources[0]?.data as { items?: Array<{ itemId?: string; target?: string }> } | undefined
  const position = initial?.items?.findIndex((item) => item.itemId === input.itemId) ?? -1
  if (position < 0 || !initial?.items)
    throw new CoreError('E_RELATION', 'Input enqueue evidence is unavailable')
  const limit = initial.items.slice(0, position + 1).filter((item) => item.target === 'next-turn').length
  for (let attempt = 0; attempt < limit; attempt++) {
    input.signal.throwIfAborted()
    const out = await input.run()
    if (out.reason !== 'completed') return out
    if (!Number.isSafeInteger(out.lastSeq) || out.lastSeq <= head)
      throw new CoreError('E_RELATION', 'Input execution made no durable progress')
    const marks = await input.read({
      type: 'inbox',
      fromSeq: input.enqueuedSeq,
      toSeq: out.lastSeq,
      order: 'desc',
      limit: 1,
    })
    const inbox = marks[0]?.data as { items?: Array<{ itemId?: string }> } | undefined
    if (!Array.isArray(inbox?.items)) throw new CoreError('E_RELATION', 'Input queue evidence is unavailable')
    if (!inbox.items.some((item) => item.itemId === input.itemId)) {
      const claims = await scanAll(input.read, {
        type: 'user/message',
        fromSeq: input.enqueuedSeq,
        toSeq: out.lastSeq,
      })
      const matching = claims.filter(
        (row) => (row.data as { itemId?: string } | null)?.itemId === input.itemId,
      )
      const claim = matching[0]
      if (matching.length !== 1 || !claim)
        throw new CoreError('E_RELATION', 'Input was removed without a verified claim')
      const ends = await input.read({
        type: 'turn/end',
        fromSeq: claim.seq + 1,
        toSeq: out.lastSeq,
        order: 'desc',
        limit: 1,
      })
      const end = ends[0]
      const starts = end
        ? await scanAll(input.read, { type: 'turn/start', fromSeq: claim.seq + 1, toSeq: end.seq })
        : []
      if (
        !end ||
        end.origin !== 'system' ||
        end.trust !== 'trusted' ||
        (end.data as { reason?: string }).reason !== 'completed' ||
        starts.length !== 1 ||
        starts[0]?.seq !== claim.seq + 1
      )
        throw new CoreError('E_RELATION', 'Completion belongs to a different input turn')
      return out
    }
    head = out.lastSeq
  }
  throw new CoreError('E_RELATION', 'Bound input remained pending after its fixed FIFO predecessors')
}
