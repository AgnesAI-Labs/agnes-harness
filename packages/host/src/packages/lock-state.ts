/** @deprecated Compatibility only; package-manager owns the implementation. */
import * as packages from '@agnes/package-manager'
import { compat } from './compat.js'

export type { LockAudit } from '@agnes/package-manager'
export const defaultVerifyIntegrity: typeof packages.defaultVerifyIntegrity = (...args) =>
  compat(packages.defaultVerifyIntegrity(...args))
export const verifyLockIntegrity = compat(packages.verifyLockIntegrity)
export const lockState = compat(packages.lockState)
export const snapshotPolicy = compat(packages.snapshotPolicy)
