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
    infer: (request, options) => current().provider.infer(request, options),
    count: (request, options) =>
      current().provider.count?.(request, options) ?? Promise.resolve({ source: 'unsupported' }),
  }
  return {
    provider,
    contractForModel: ((target) => current().contractForModel(target)) as ModelSnapshot['contractForModel'],
    run<T>(operation: () => Promise<T>): Promise<T> {
      return scope.run(active, operation)
    },
    publish(next: ModelSnapshot): void {
      active = next
    },
  }
}
