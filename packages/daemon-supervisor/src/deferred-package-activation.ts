import type { PackageActivationAdapter } from '@agnes/daemon-admin/packages/index'

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
    async generations(profileName) {
      const read = current()?.generations
      if (!read) throw new Error('E_PACKAGE_STATE: generation status unavailable')
      return read(profileName)
    },
    async publicationStatus(profileName) {
      const adapter = current()
      if (!adapter?.publicationStatus) throw new Error('E_PACKAGE_STATE: publication status unavailable')
      return adapter.publicationStatus(profileName)
    },
    async migrateSession(profileName, sessionId, principalId) {
      const adapter = current()
      if (!adapter?.migrateSession) throw new Error('E_PACKAGE_STATE: session migration unavailable')
      return adapter.migrateSession(profileName, sessionId, principalId)
    },
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
