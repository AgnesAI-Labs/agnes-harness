import { type Context, type Fiber, FiberState, symbols } from '@agnes/cordis'
import type {
  PluginProfileRuntimePort,
  PluginServicesPort,
  ProfileManagedDefinition,
} from '@agnes/extension-api'
import type { RowOriginLookup } from '@agnes/plugin-runtime/host'
import type { PluginCapabilities } from '@agnes/protocol'
import { rpcError } from '@agnes/protocol'
import { pluginRowSource } from '../ext-host/row-extension-host.js'
import type { ProfileManagedResources } from './managed.js'
import { registerManagedServices } from './managed-services.js'
import { ownedStore } from './owned-store.js'
import type { ProfileStreams } from './streams.js'

export function installProfileRuntime(
  root: Context,
  origins: RowOriginLookup,
  deps: {
    managed: ProfileManagedResources
    streams: ProfileStreams
    namespace(owner: string, name: string): import('@agnes/extension-api').PersistenceMetadataNamespace
    describe(
      packageId: string,
      snapshotId: string,
      exportName?: string,
    ): { integrity?: string; declaredCapabilities?: PluginCapabilities } | undefined
  },
) {
  const resolve = (context: Context) => {
    let fiber: Fiber = context.fiber
    while (!origins.lookup(fiber) && fiber !== fiber.parent.fiber) fiber = fiber.parent.fiber
    const origin = origins.lookup(fiber)
    if (!origin || origin.trustTier !== 'third-party' || !origin.rowRevision)
      throw rpcError('CAPABILITY_DENIED')
    const description = deps.describe(origin.packageId, origin.snapshotId, origin.exportName)
    if (!description?.integrity) throw rpcError('CAPABILITY_DENIED')
    const assert = () => {
      if (
        origins.lookup(fiber) !== origin ||
        fiber.state === FiberState.UNLOADING ||
        fiber.state === FiberState.DISPOSED
      )
        throw rpcError('CAPABILITY_DENIED')
    }
    assert()
    return {
      fiber,
      origin,
      owner: pluginRowSource(origin.rowId),
      integrity: description.integrity,
      revision: origin.rowRevision,
      capabilities: description.declaredCapabilities,
      assert,
    }
  }
  const facet: PluginProfileRuntimePort = {
    register<T>(this: { ctx: Context }, definition: ProfileManagedDefinition<T>) {
      const row = resolve(this.ctx),
        descriptor = row.capabilities?.managedServices?.find(
          (d) => d.id === definition.id && d.scope === 'profile',
        )
      if (!descriptor || descriptor.artifact.kind !== 'in-process' || row.capabilities?.store !== true)
        throw rpcError('CAPABILITY_DENIED')
      const handle = deps.managed.register({
        ...row,
        packageId: row.origin.packageId,
        wakesAllowed: row.capabilities?.wake === true,
        definition,
        descriptor,
        store: ownedStore(deps.namespace(row.owner, `managed:${definition.id}`), () => {}, true),
      })
      row.fiber.effect(() => () => handle.release(), `profile.managed(${definition.id})`)
      registerManagedServices(
        definition.id,
        this.ctx.get('services') as PluginServicesPort,
        handle,
        () => deps.managed.settle(),
        definition.configSchema,
        definition.checkSchema,
      )
      return handle
    },
    async connectProducer(this: { ctx: Context }, target, input, context) {
      const row = resolve(this.ctx)
      if (
        !row.capabilities?.managedServices?.some(
          (d) =>
            d.scope === 'profile' &&
            d.requires.some(
              (g) => g.extension === target.extension && g.name === target.name && g.range === '*',
            ),
        )
      )
        throw rpcError('CAPABILITY_DENIED')
      await deps.streams.forward(
        { ...row, packageId: row.origin.packageId },
        target.extension,
        target.name,
        input,
        context,
      )
    },
    get streams(): PluginProfileRuntimePort['streams'] {
      throw new Error('unbound profile streams')
    },
  }
  // Cordis tracks `ctx` per access, including nested services. No plugin can select another row.
  Object.defineProperty(facet, 'streams', {
    get(this: { ctx: Context }) {
      const row = resolve(this.ctx)
      return {
        register: (name: string, handler: import('@agnes/extension-api').StreamHandler) =>
          row.fiber.effect(() => {
            const abort = new AbortController()
            const off = deps.streams
              .bind({ ...row, declarations: row.capabilities?.streams ?? [], signal: abort.signal })
              .register(name, handler)
            return () => {
              abort.abort()
              off()
            }
          }, `profile.stream(${name})`),
      }
    },
  })
  Object.defineProperty(facet, symbols.tracker, { value: { property: 'ctx' } })
  root.provide('profileRuntime', facet)
}
