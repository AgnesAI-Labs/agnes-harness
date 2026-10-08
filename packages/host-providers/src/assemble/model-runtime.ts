import { AsyncLocalStorage } from 'node:async_hooks'
import type { KernelOptions, Provider } from '@agnes/core'

type ModelSnapshot = {
  provider: Provider
  contractForModel: NonNullable<KernelOptions['contractForModel']>
  dispose(): Promise<void>
}
type Image = ModelSnapshot & { uses: number; retired: boolean; drained?: () => void }

/** One coherent model/contract image for a request, including asynchronous preparation and counting. */
export function modelRuntime(initial: ModelSnapshot, onDisposeError: (error: unknown) => void) {
  const image = (snapshot: ModelSnapshot): Image => ({ ...snapshot, uses: 0, retired: false })
  let active = image(initial)
  let closing: Promise<void> | undefined
  const scope = new AsyncLocalStorage<Image>()
  const retiring = new Set<Promise<void>>()
  const current = () => scope.getStore() ?? active
  const use = (snapshot: Image) => {
    if ((closing && scope.getStore() !== snapshot) || (snapshot.retired && snapshot.uses === 0))
      throw new Error('model provider is retired')
    snapshot.uses++
    return () => {
      if (--snapshot.uses === 0) snapshot.drained?.()
    }
  }
  const retire = (snapshot: Image) => {
    snapshot.retired = true
    const drained =
      snapshot.uses === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            snapshot.drained = resolve
          })
    const disposal = drained.then(() => snapshot.dispose())
    retiring.add(disposal)
    // Successful retirements retain no snapshots. Failed cleanup is also reported at close.
    void disposal.then(() => retiring.delete(disposal), onDisposeError)
  }
  const provider: Provider = {
    models: () => current().provider.models(),
    infer: (request, options) => {
      const snapshot = current()
      return (async function* () {
        const release = use(snapshot)
        try {
          yield* snapshot.provider.infer(request, options)
        } finally {
          release()
        }
      })()
    },
    count: async (request, options) => {
      const snapshot = current()
      const release = use(snapshot)
      try {
        return (await snapshot.provider.count?.(request, options)) ?? { source: 'unsupported' }
      } finally {
        release()
      }
    },
  }
  return {
    provider,
    contractForModel: ((target) => current().contractForModel(target)) as ModelSnapshot['contractForModel'],
    async run<T>(operation: () => Promise<T>): Promise<T> {
      if (closing) throw new Error('model runtime is closed')
      const snapshot = active
      const release = use(snapshot)
      try {
        return await scope.run(snapshot, operation)
      } finally {
        release()
      }
    },
    publish(next: ModelSnapshot): void {
      if (closing) throw new Error('model runtime is closed')
      const previous = active
      active = image(next)
      retire(previous)
    },
    dispose(): Promise<void> {
      if (!closing) {
        retire(active)
        closing = Promise.allSettled([...retiring]).then((results) => {
          const failures = results.filter((result) => result.status === 'rejected')
          if (failures.length)
            throw new AggregateError(
              failures.map((result) => result.reason),
              'model provider cleanup failed',
            )
        })
      }
      return closing
    },
  }
}
