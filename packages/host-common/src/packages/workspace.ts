/** @deprecated Compatibility only; package-manager owns the implementation. */
import * as packages from '@agnes/package-manager'
import { compat } from './compat.js'

export type { WorkspaceVerification } from '@agnes/package-manager'
export const readDeployManifest = compat(packages.readDeployManifest)
export const hashWorkspace = compat(packages.hashWorkspace)
export const readProfileFragment = compat(packages.readProfileFragment)
export const verifyWorkspace = compat(packages.verifyWorkspace)
