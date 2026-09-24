import type { SurfacesMountsResult } from '@agnes/protocol'
import { isRoutableSurfaceInstance, type SurfaceControllerSnapshot } from '../../surfaces/types.js'
import type { LocalEndpoint } from '../endpoint.js'

/** The narrow read this method needs off a live (or not-yet-started) SurfaceController. */
export type SurfaceMountsSource = {
  snapshot(): SurfaceControllerSnapshot | undefined
}

/**
 * Registers `_agnes/v1/surfaces.mounts`: the read-only mount->endpoint table a browser-facing
 * `createMountProxy` needs to reverse-proxy a request to a mounted Surface's loopback listener.
 *
 * This exists because `createMountProxy` (packages/daemon/src/surfaces/mount-proxy.ts) needs a
 * synchronous `lookup()`, but in the real `agnes serve` deployment the browser-facing
 * `createWebServer` runs in a genuinely separate OS process (`packages/cli/launch/web-command.ts`,
 * spawned detached from `agnesd` -- see `packages/cli/src/boot/backend.ts`), connected to the daemon
 * only over the existing local RPC channel `ensureLocalBackend` already establishes. A JS closure over
 * `SurfaceController` cannot cross that boundary, so that process needs an RPC method instead. This
 * method is that bridge: it exposes {package, surfaceId, mount, host, port} for each currently
 * healthy instance. The proxy only needs the last three fields; package/surfaceId let the
 * authenticated plugin-admin BFF associate a real route with its installed package without guessing
 * a URL. It exposes nothing else about deployment or secrets.
 *
 * No extra authKind check beyond what the caller wires: a connection that reaches this method at all
 * can read where a Surface it can already browse is routed. Unlike `workspace.list`/`workspace.add`/
 * `session.list`, though, `startSupervisor` only ever registers this on the `unix` transport (M4,
 * final review) -- its only real consumer is the local CLI process bridging this same-machine
 * `agnes serve` process boundary, not a remote WSS client.
 */
export function registerSurfaces(endpoint: LocalEndpoint, source: SurfaceMountsSource): void {
  endpoint.register('_agnes/v1/surfaces.mounts', async (): Promise<SurfacesMountsResult> => {
    const instances = source.snapshot()?.instances ?? []
    // I3 (final review, Important): shared healthy-instance filter with the since-retired
    // `supervisor.ts` `surfaceMountProxy` closure -- see `isRoutableSurfaceInstance`'s own doc.
    const mounts = instances.filter(isRoutableSurfaceInstance).map((instance) => ({
      package: instance.package,
      surfaceId: instance.surfaceId,
      mount: instance.mount,
      host: instance.endpoint.host,
      port: instance.endpoint.port,
    }))
    return { mounts }
  })
}
