/** @deprecated Compatibility only; package-manager owns the implementation. */
import * as packages from '@agnes/package-manager'
import { compat } from './compat.js'

export { LICENSE_ALLOWLIST } from '@agnes/package-manager'
export const isDangerous = compat(packages.isDangerous)
export const verifyInstalledIntegrity = compat(packages.verifyInstalledIntegrity)
export const runTrustGate = compat(packages.runTrustGate)
export const manifestCapabilities = compat(packages.manifestCapabilities)
