import type { LoopContext } from '@agnes/extension-api'

export type ModelReply = Awaited<ReturnType<LoopContext['model']['complete']>>

/** Deterministic model port. Exhaustion is an error so missing interactions cannot pass silently. */
export function scriptedModel(replies: readonly ModelReply[]) {
  const requests: Parameters<LoopContext['model']['stream']>[0][] = []
  let cursor = 0
  const model: Pick<LoopContext['model'], 'stream' | 'complete'> = {
    async *stream(request, signal) {
      signal.throwIfAborted()
      const reply = replies[cursor++]
      if (!reply) throw new Error('Scripted model replies exhausted')
      requests.push(structuredClone(request))
      for (const event of reply) {
        signal.throwIfAborted()
        yield structuredClone(event)
      }
    },
    async complete(request, signal) {
      const events: ModelReply[number][] = []
      for await (const event of model.stream(request, signal)) events.push(event)
      return events
    },
  }
  return {
    model,
    requests,
    get remaining() {
      return replies.length - cursor
    },
  }
}
