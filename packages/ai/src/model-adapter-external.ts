import * as modelAdapter from './model-adapter.js'

/** Bind only the public adapter namespace at the owning model subsystem's bootstrap boundary. */
export function bindModelAdapterExternal(register: (specifier: string, namespace: object) => void): void {
  register('@agnes/ai/model-adapter', modelAdapter)
}
