import type { Operation } from '@agnes/core'
import type { OperationDeps } from '@agnes/host-extensions/assemble/packages'
import { toSeamAdapters } from '../adapters/index.js'
import type { Assembled } from './assembled.js'
import { type AssemblyContext, duplicateContribution } from './context.js'
import type { PackageSet } from './packages.js'
import type { ProcessServices } from './process-services.js'
import type { SeamContexts } from './seam-contexts.js'

/**
 * Step `operations` - the operation and runtime factory tables are called here, with the
 * dependencies an Operation cannot construct for itself.
 */
export function buildOperations(
  ctx: AssemblyContext,
  pkgs: PackageSet,
  proc: ProcessServices,
  seamContexts: SeamContexts,
) {
  const { deps, refuse } = ctx
  const { modules } = pkgs
  const { adapters, secrets } = proc
  const { seamProfile } = seamContexts
  const hostAdapters = toSeamAdapters(adapters, { owner: '@agnes/host' })
  const opDeps: OperationDeps = {
    log: deps.log,
    signal: ctx.abort.signal,
    adapters: hostAdapters,
    secrets,
    ext: {},
    profile: seamProfile,
  }
  const operations: Operation[] = []
  const runtimes: Assembled['runtimes'] = {}
  for (const m of modules.values()) {
    for (const [name, make] of Object.entries(m.operations ?? {})) {
      const op = make(opDeps)
      if (!op || typeof op.run !== 'function')
        refuse('E_EXT_LOAD', `${m.id}: operations.${name} returned no Operation`, {
          id: m.id,
          operation: name,
        })
      operations.push(op)
    }
    for (const [n, f] of Object.entries(m.runtimes ?? {}))
      runtimes[n as keyof Assembled['runtimes']] =
        n in runtimes ? duplicateContribution(m.id, 'runtime', n) : f
  }
  return { operations, runtimes }
}
