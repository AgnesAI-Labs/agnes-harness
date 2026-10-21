import type { AssemblyLifetime } from './assembly-lifetime.js'
import type { AssemblyBase } from './assembly-options.js'
import type { RuntimeState } from './assembly-runtime.js'
import type { StoresState } from './assembly-stores.js'
import type { WorkersState } from './assembly-workers.js'

export async function rebuildClientModules(
  state: AssemblyBase & StoresState & WorkersState & RuntimeState,
  lifetime: AssemblyLifetime,
) {
  const { o, notices, runtimeDelivery, effectivePackageAdmin } = state
  runtimeDelivery?.completeStartup()
  if (effectivePackageAdmin) {
    const stopClientModuleNotices = effectivePackageAdmin.service.subscribeClientModules((event) =>
      notices.emit('packages_changed', { detail: event }),
    )
    lifetime.own({
      stop: () => {
        stopClientModuleNotices()
        effectivePackageAdmin.service.closeClientModules()
      },
      dispose: () => undefined,
    })
    await effectivePackageAdmin.service.rebuildClientModules(o.profile.name)
  }

  return {}
}

export type ModulesState = Awaited<ReturnType<typeof rebuildClientModules>>
