import type { Plugin, RegistryService } from './registry.js'

const runtimes = new WeakMap<RegistryService, Set<Plugin.Runtime>>()

export function registerPreparedRuntime(registry: RegistryService, runtime: Plugin.Runtime): void {
  let owned = runtimes.get(registry)
  if (!owned) {
    owned = new Set()
    runtimes.set(registry, owned)
  }
  owned.add(runtime)
}

export function unregisterPreparedRuntime(registry: RegistryService, runtime: Plugin.Runtime): void {
  const owned = runtimes.get(registry)
  if (!owned) return
  owned.delete(runtime)
  if (!owned.size) runtimes.delete(registry)
}

export function preparedRuntimeValues(registry: RegistryService): Iterable<Plugin.Runtime> {
  return runtimes.get(registry) ?? []
}
