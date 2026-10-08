/** @deprecated Compatibility only; package-manager owns the implementation. */
import * as packages from '@agnes/package-manager'
import { compat } from './compat.js'
export const manifestCapabilities = compat(packages.manifestCapabilities)
export const assertCapabilityCeiling = compat(packages.assertCapabilityCeiling)
