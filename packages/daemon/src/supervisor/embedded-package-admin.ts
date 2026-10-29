import {
  createPackageAdminService,
  type PackageAdminService,
  type RuntimePinsAdapter,
} from '@agnes/daemon-admin/packages/index'
import { assemblyPort } from './assembly-lifetime.js'

type OperationListener = Parameters<PackageAdminService['subscribe']>[0]
type ModuleListener = Parameters<PackageAdminService['subscribeClientModules']>[0]

function forward<T>(listeners: Set<(event: T) => void>, event: T): void {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch {
      /* Observers cannot change an operation. */
    }
  }
}

/** A custom starter sees one service, whether it supplies only a catalog or delegates real boot. */
export function packageAdminHandoff(catalog: PackageAdminService) {
  let current = catalog
  let initialized = false
  let closed = false
  let modulesClosed = false
  const operations = new Set<OperationListener>()
  const modules = new Set<ModuleListener>()
  const subscriptions = {
    operations: current.subscribe((event) => forward(operations, event)),
    modules: current.subscribeClientModules((event) => forward(modules, event)),
  }
  const read = (): PackageAdminService => {
    if (closed) throw new Error('E_PACKAGE_STATE: PackageAdmin owner is closed')
    return current
  }
  const closeModules = (): void => {
    if (modulesClosed) return
    const selected = read()
    modulesClosed = true
    selected.closeClientModules()
  }
  const service: PackageAdminService = {
    call: async (...args) => await read().call(...args),
    recover: async () => await read().recover(),
    rebuildClientModules: async (profile) => await read().rebuildClientModules(profile),
    subscribe(listener) {
      read()
      operations.add(listener)
      return () => {
        operations.delete(listener)
      }
    },
    subscribeClientModules(listener) {
      read()
      modules.add(listener)
      return () => {
        modules.delete(listener)
      }
    },
    closeClientModules: closeModules,
    async candidateForCommand(...args) {
      const selected = read()
      if (!selected.candidateForCommand) throw new Error('E_PACKAGE_STATE')
      return await selected.candidateForCommand(...args)
    },
    async candidateEvidence(...args) {
      const selected = read()
      if (!selected.candidateEvidence) throw new Error('E_PACKAGE_STATE')
      return await selected.candidateEvidence(...args)
    },
  }
  return {
    service,
    initialize(ready: PackageAdminService): void {
      if (initialized || closed) throw new Error('E_PACKAGE_STATE: PackageAdmin already initialized')
      subscriptions.operations()
      subscriptions.modules()
      closeModules()
      current = ready
      initialized = true
      modulesClosed = false
      subscriptions.operations = current.subscribe((event) => forward(operations, event))
      subscriptions.modules = current.subscribeClientModules((event) => forward(modules, event))
    },
    close(): void {
      if (closed) return
      closed = true
      const errors: unknown[] = []
      for (const release of [
        () => {
          if (!modulesClosed) {
            modulesClosed = true
            current.closeClientModules()
          }
        },
        subscriptions.operations,
        subscriptions.modules,
      ]) {
        try {
          release()
        } catch (error) {
          errors.push(error)
        }
      }
      operations.clear()
      modules.clear()
      if (errors.length) throw new AggregateError(errors, 'PackageAdmin cleanup failed')
    },
  }
}

/** Embedded starters may serve catalog/recovery without constructing a worker runtime. */
export function embeddedPackageAdmin(options: Parameters<typeof createPackageAdminService>[0]) {
  const pins = assemblyPort<RuntimePinsAdapter>()
  const owner = packageAdminHandoff(
    createPackageAdminService({
      ...options,
      runtimePins: {
        async inspect(profile) {
          return pins.read().inspect(profile)
        },
        async release(profile, ids) {
          return pins.read().release(profile, ids)
        },
      },
    }),
  )
  return {
    ...owner,
    bindRuntimePins: pins.initialize,
    close(): void {
      try {
        owner.close()
      } finally {
        pins.close()
      }
    },
  }
}
