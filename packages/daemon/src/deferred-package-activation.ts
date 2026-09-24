import type { PackageActivationAdapter } from './packages/index.js'

const unavailable = Object.freeze({
  code: 'E_PACKAGE_STATE',
  safeMessage: 'Package state does not allow this action.',
  blockers: [],
})

/**
 * A stable adapter for a service that is built before the real activation exists: every call reads
 * the adapter at call time, and answers "unavailable" until there is one.
 */
export function deferPackageActivation(
  current: () => PackageActivationAdapter | undefined,
): PackageActivationAdapter {
  return {
    async actual(profileName, packageId) {
      return current()?.actual(profileName, packageId) ?? { actual: 'unavailable' }
    },
    async stopped(profileName, packageId) {
      return current()?.stopped?.(profileName, packageId) ?? false
    },
    async prepareRemoval(profileName, packageId) {
      await current()?.prepareRemoval?.(profileName, packageId)
    },
    async reconcile(input) {
      return current()?.reconcile(input) ?? { actual: 'unavailable', error: unavailable }
    },
  }
}
