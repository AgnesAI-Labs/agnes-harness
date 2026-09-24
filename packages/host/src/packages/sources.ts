/** @deprecated Compatibility only; package-manager owns the implementation. */
import * as packages from '@agnes/package-manager'
import { compat } from './compat.js'

export type { ExecFn, FetchedSource, PackageSource } from '@agnes/package-manager'
export const parseSource = compat(packages.parseSource)
export const hashDirectory = compat(packages.hashDirectory)
export const fetchSource = compat(packages.fetchSource)
export const packageDir = compat(packages.packageDir)
