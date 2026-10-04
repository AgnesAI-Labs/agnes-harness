import { AsyncLocalStorage } from 'node:async_hooks'
import type { KernelOptions, Provider } from '@agnes/core'

type ModelSnapshot = {
  provider: Provider
  contractForModel: NonNullable<KernelOptions['contractForModel']>
}

/** One coherent model/contract image for a request, including asynchronous preparation and counting. */
export function modelRuntime(initial: ModelSnapshot) {
  let active = initial
  const scope = new AsyncLocalStorage<ModelSnapshot>()
  const current = () => scope.getStore() ?? active
  const provider: Provider = {
    models: () => current().provider.models(),
    prepare: (request, options) =>
      current().provider.prepare?.(request, options) ?? Promise.resolve(undefined),
    infer: (request, options) => current().provider.infer(request, options),
    count: (request, options) =>
      current().provider.count?.(request, options) ?? Promise.resolve({ source: 'unsupported' }),
  }
  return {
    provider,
    contractForModel: ((target) => current().contractForModel(target)) as ModelSnapshot['contractForModel'],
    run<T>(operation: () => Promise<T>): Promise<T> {
      return scope.run(current(), operation)
    },
    retain() {
      const snapshot = current()
      return {
        run<T>(operation: () => Promise<T>): Promise<T> {
          return scope.run(snapshot, operation)
        },
      }
    },
    publish(next: ModelSnapshot): void {
      active = next
    },
  }
}
