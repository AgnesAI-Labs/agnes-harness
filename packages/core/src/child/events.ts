import type { ChildAgentEvent, ChildAgentResult } from '@agnes/extension-api'

/** A single-subscriber event queue whose `result` settles once. */
export function createChildEventQueue(): {
  push(event: ChildAgentEvent): void
  events(): AsyncIterable<ChildAgentEvent>
  settle(result: ChildAgentResult): void
  fail(error: unknown): void
  readonly result: Promise<ChildAgentResult>
  readonly settled: boolean
} {
  const queued: ChildAgentEvent[] = []
  const waiters: Array<() => void> = []
  let finished = false
  let settled = false
  let resolveResult: (value: ChildAgentResult) => void = () => undefined
  let rejectResult: (error: unknown) => void = () => undefined
  const result = new Promise<ChildAgentResult>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  const wake = () => {
    for (const waiter of waiters.splice(0)) waiter()
  }
  return {
    push(event) {
      if (finished) return
      queued.push(event)
      wake()
    },
    settle(value) {
      if (settled) return
      settled = true
      finished = true
      resolveResult(value)
      wake()
    },
    fail(error) {
      if (settled) return
      settled = true
      finished = true
      rejectResult(error)
      wake()
    },
    get settled() {
      return settled
    },
    result,
    async *events() {
      for (;;) {
        while (queued.length > 0) yield queued.shift() as ChildAgentEvent
        if (finished) return
        await new Promise<void>((resolve) => waiters.push(resolve))
      }
    },
  }
}
