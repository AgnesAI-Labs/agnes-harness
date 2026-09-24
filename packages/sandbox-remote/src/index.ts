import { remoteSandboxSeam } from './seam.js'

export * from './owner-pool.js'
export type { RemoteSandboxContext, RemoteSandboxProfile, SeamFactory } from './seam.js'
export { remoteSandboxSeam } from './seam.js'

/**
 * This package's one export point: a deployment names `"@agnes/sandbox-remote"` in
 * `profile.seams.sandbox` and the host's `PackageModule` loader picks this table up. The loader
 * (`readNamedExports` / `readFactoryTable` in `packages/host/src/assemble/packages.ts`) checks only
 * that each entry is a function - there is no cross-package compile-time check against the host's
 * own `SeamFactory` type - so this table, not a type, is what actually wires the seam in.
 */
export const seams = { sandbox: remoteSandboxSeam } as const
