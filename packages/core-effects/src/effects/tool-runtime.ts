import type {
  ToolRuntime,
  ToolRuntimeCall,
  ToolRuntimeExecution,
  ToolRuntimeProvider,
  ToolSchedulingPolicy,
} from '@agnes/extension-api'
import { scheduleBatch } from './scheduler.js'

const skipped = () => ({
  content: [{ type: 'text' as const, text: 'aborted before dispatch' }],
  isError: true,
})

/** Existing safe-run/exclusive-barrier scheduling, now usable by every loop. */
export const defaultToolRuntimeProvider = {
  id: 'default',
  version: '1.0.0',
  create(options: ToolSchedulingPolicy): ToolRuntime {
    if (!Number.isSafeInteger(options.maxParallel) || options.maxParallel < 1)
      throw new Error('tools.max_parallel must be a positive integer')
    let lifetime = new AbortController()
    let disposed = false
    const active = new Set<Promise<unknown>>()
    const run = <T>(signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      if (disposed) return Promise.reject(new Error('Tool runtime is disposed'))
      // A later turn gets a fresh cancellation scope after the previous calls have drained.
      if (lifetime.signal.aborted && active.size === 0) lifetime = new AbortController()
      const combined = AbortSignal.any([signal, lifetime.signal])
      const promise = work(combined)
      active.add(promise)
      return promise.finally(() => active.delete(promise))
    }
    const cancel = async () => {
      lifetime.abort()
      await Promise.allSettled([...active])
    }
    return {
      execute(call: ToolRuntimeCall, execution: ToolRuntimeExecution, signal: AbortSignal) {
        return run(signal, async (combined) =>
          combined.aborted ? skipped() : execution.dispatch(call, combined),
        )
      },
      batch(calls, execution, signal) {
        return run(signal, async (combined) => {
          const stopped = new AbortController()
          const batchSignal = AbortSignal.any([combined, stopped.signal])
          let failed = false
          let failure: unknown
          const results = await scheduleBatch(
            calls.map((call, ordinal) => ({
              ordinal,
              concurrencySafe: call.concurrencySafe,
              run: async () => {
                try {
                  return await execution.dispatch(call, batchSignal)
                } catch (error) {
                  if (!failed) {
                    failed = true
                    failure = error
                  }
                  stopped.abort()
                  return skipped()
                }
              },
            })),
            { maxParallel: options.maxParallel, signal: batchSignal, onSkipped: skipped },
          )
          if (failed) throw failure
          return results
        })
      },
      cancel,
      async dispose() {
        disposed = true
        await cancel()
      },
    }
  },
} satisfies ToolRuntimeProvider
