import { createPackageAdminService, type RuntimePinsAdapter } from '@agnes/daemon-admin/packages/index'
import { assemblyPort } from './assembly-lifetime.js'

/** Embedded starters may serve catalog/recovery without constructing a worker runtime. */
export function embeddedPackageAdmin(options: Parameters<typeof createPackageAdminService>[0]) {
  const pins = assemblyPort<RuntimePinsAdapter>()
  return {
    bindRuntimePins: pins.initialize,
    service: createPackageAdminService({
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
  }
}
