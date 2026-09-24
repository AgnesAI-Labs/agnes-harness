import type { ResolvedDeployment } from '@agnes/host'
import { resolveDeployment } from '@agnes/host'
import type { InstalledInventory } from '@agnes/package-manager'
import { resolveDeployDir } from './deploy-dir.js'
import { buildDeploymentPolicy } from './deployment-policy.js'
import type { SurfaceController } from './types.js'

/** Pure "resolve, don't start" half of `coordinateSurfacesOnBoot`: deploy-dir lookup -> policy ->
 * `resolveDeployment`, with no `controller.start` and no try/catch of its own. `coordinateSurfacesOnBoot`
 * below is this file's only caller. Preserves the exact "no deploy dir" early return
 * (`resolveDeployDir` returns undefined -> undefined here) that `coordinateSurfacesOnBoot` has
 * always had. */
export function resolveSurfaceDeployment(deps: {
  profileDir: string
  inventory: InstalledInventory
  harnessVersion: string
  surfaceApiVersion: string
}): ResolvedDeployment | undefined {
  const deployDir = resolveDeployDir(deps.profileDir)
  if (!deployDir) return undefined
  const policy = buildDeploymentPolicy({
    deployDir,
    profileDir: deps.profileDir,
    harnessVersion: deps.harnessVersion,
    surfaceApiVersion: deps.surfaceApiVersion,
  })
  return resolveDeployment(deps.inventory, deployDir, policy)
}

/** Runs once per daemon start -- called unconditionally from `startSupervisor`. A Surface is an OS
 * child process that dies with every daemon stop, so boot coordination cannot be skipped after the
 * first start. */
export async function coordinateSurfacesOnBoot(deps: {
  profileDir: string
  inventory: InstalledInventory
  controller: SurfaceController
  harnessVersion: string
  surfaceApiVersion: string
  signal: AbortSignal
}): Promise<ResolvedDeployment | undefined> {
  // C1 (final review, Critical): `resolveDeployment` and `controller.start` can both fail for reasons
  // entirely outside the daemon's control -- a bad artifact, a health-probe timeout, a `harnessRange`
  // mismatch, or a package removed from the inventory while a deploy still references it. None of
  // those are a reason to take the WHOLE daemon down: `startSupervisor`'s own outer try/catch (this
  // function's only caller) has no way to distinguish "Surface boot failed" from "daemon boot failed",
  // so an uncaught throw here used to abort every socket, worker, and RPC endpoint along with it. This
  // degrades instead: on failure, log it the same way this codebase already reports non-fatal daemon
  // startup conditions (`console.error`, see supervisor.ts's own listener-failure and readiness
  // messages) and return `undefined`, exactly like the "profile never trusted a deploy directory"
  // no-op path inside `resolveSurfaceDeployment` above. The caller stores this in
  // `resolvedSurfaceDeployment`, which the mount proxy and `/admin/plugins` reconcile path already
  // treat as "nothing to route to" when absent -- so this degrades to "no mount matches" rather than
  // crashing.
  try {
    const deployment = resolveSurfaceDeployment(deps)
    if (!deployment) return undefined
    if (deployment.surfaces.length === 0) return deployment
    await deps.controller.start(deployment, deps.signal)
    return deployment
  } catch (error) {
    console.error(
      `agnesd Surface boot coordination failed; continuing without Surfaces: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return undefined
  }
}
