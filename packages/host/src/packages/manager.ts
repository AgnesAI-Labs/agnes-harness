/** @deprecated Compatibility only; package-manager owns the implementation. */
import * as packages from '@agnes/package-manager'
import { compat } from './compat.js'

export type { ManagerOptions, PackageStatus } from '@agnes/package-manager'
export const readManifestIn = compat(packages.readManifestIn)
export type PackageManager = Pick<
  packages.PackageManager,
  'add' | 'trust' | 'enable' | 'remove' | 'rollback' | 'trustWorkspace' | 'status'
>
export const createPackageManager = (options: packages.ManagerOptions): PackageManager => {
  const manager = compat(packages.createPackageManager)(options)
  return {
    add: compat(manager.add),
    trust: compat(manager.trust),
    enable: compat(manager.enable),
    remove: compat(manager.remove),
    rollback: compat(manager.rollback),
    trustWorkspace: compat(manager.trustWorkspace),
    status: compat(manager.status),
  }
}
