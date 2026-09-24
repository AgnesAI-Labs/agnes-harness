/** @deprecated Compatibility only; package-manager owns the implementation. */
import * as packages from '@agnes/package-manager'
import { compat } from './compat.js'

export type { LockEntry, Lockfile } from '@agnes/package-manager'
export { lockPath } from '@agnes/package-manager'
export const emptyLock = compat(packages.emptyLock)
export const readLock = compat(packages.readLock)
export const writeLock = compat(packages.writeLock)
export const withLock = compat(packages.withLock)
