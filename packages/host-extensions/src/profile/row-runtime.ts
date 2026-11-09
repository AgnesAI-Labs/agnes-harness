import { type Context, type Fiber, FiberState, symbols } from '@agnes/cordis'
import type {
  PluginProfileRuntimePort,
  PluginServicesPort,
  ProfileManagedDefinition,
} from '@agnes/extension-api'
import { CHANNEL_CONFIG_SCHEMA, channelKind, channelServiceCapabilities } from '@agnes/extension-api'
import type { RowOriginLookup } from '@agnes/plugin-runtime/host'
import type { PluginCapabilities } from '@agnes/protocol'
import { rpcError } from '@agnes/protocol'
import { frozenJson } from '../ext-host/frozen-json.js'
import { pluginRowSource } from '../ext-host/row-extension-host.js'
import type { ChannelRuntimeFactory } from './channel-runtime.js'
import type { ProfileManagedResources } from './managed.js'
import { registerManagedServices } from './managed-services.js'
import { ownedStore } from './owned-store.js'
import type { ProfileStreams } from './streams.js'

export function installProfileRuntime(
  root: Context,
  origins: RowOriginLookup,
  deps: {
    channelRuntime?: ChannelRuntimeFactory
    channelStateDirectory?: string
    channelScope?: { home: string; profile: string; dataDir: string; workspace: string }
    resolveSecret?(ref: string): string
    channelLog?: import('@agnes/extension-api').Logger
    channelDirectory?: Map<string, () => import('@agnes/protocol').JsonValue>
    channelCurrent?(owner: string, integrity: string, revision: string): unknown
    channelRemember?(packageId: string, owner: string): void
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
  const recoveries = new WeakMap<object, (config: import('@agnes/protocol').JsonValue, store: import('@agnes/extension-api').OwnedStore) => import('@agnes/protocol').JsonValue>()
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
    registerChannel(this: { ctx: Context }, provider, config = { instances: [] }) {
      const row = resolve(this.ctx)
      if (
        !deps.channelRuntime ||
        !deps.channelStateDirectory ||
        !deps.channelScope ||
        !deps.resolveSecret ||
        !deps.channelLog ||
        !row.capabilities?.network?.length
      )
        throw rpcError('CAPABILITY_DENIED')
      channelKind.validate(provider)
      deps.channelRemember?.(row.origin.packageId, row.owner)
      const registered = Object.freeze({
        id: provider.id,
        version: provider.version,
        manifest: frozenJson(structuredClone(provider.manifest)),
        ...(provider.configSchema
          ? { configSchema: frozenJson(structuredClone(provider.configSchema)) }
          : {}),
        create: provider.create.bind(provider),
      })
      // Register through the same row-attributed provider port; no plugin can select another owner.
      this.ctx.get('providers').register(channelKind, registered)
      const definition: ProfileManagedDefinition<import('@agnes/extension-api').ChannelRuntime> = {
        id: 'channel',
        configSchema: CHANNEL_CONFIG_SCHEMA,
        defaultConfig: config as unknown as import('@agnes/protocol').JsonValue,
        start: (init) =>
          deps.channelRuntime!(registered, init, {
            ...deps.channelScope!,
            owner: row.owner,
            stateDirectory: deps.channelStateDirectory!,
            resolveSecret: (ref) => {
              init.assertCurrent()
              const grants = row.capabilities?.secrets ?? []
              if (
                !grants.some(
                  (grant) =>
                    grant === ref ||
                    (/^secret:\/\/[a-z0-9-]+\/\*$/.test(grant) && ref.startsWith(grant.slice(0, -1))),
                )
              )
                throw rpcError('CAPABILITY_DENIED')
              return deps.resolveSecret!(ref)
            },
            log: deps.channelLog!,
          }),
        async check(value) {
          return value.status()
        },
      }
      if (deps.channelRuntime.snapshot) recoveries.set(definition, (config, store) =>
        deps.channelRuntime!.snapshot!(registered, config as unknown as import('@agnes/extension-api').ChannelConfiguration, store, row.owner))
      const handle = (this.ctx.get('profileRuntime') as PluginProfileRuntimePort).register(definition)
      const capabilities = channelServiceCapabilities()
      const bindingAvailable = capabilities.every((cap) =>
        row.capabilities?.services?.some((d) => d.name === cap.name && d.scope === 'session'),
      )
      if (bindingAvailable) {
        const services = this.ctx.get('services') as PluginServicesPort
        for (const capability of capabilities)
          services.register({
            ...capability,
            async handler(input, context) {
              row.assert()
              if (!context.session || context.actor.role === 'agent') throw rpcError('CAPABILITY_DENIED')
              const runtime = await deps.managed.currentValue<import('@agnes/extension-api').ChannelRuntime>(
                row.owner,
                'channel',
                row.integrity,
              )
              const session = { id: context.session.key, workspace: context.session.workspaceRoot }
              if (capability.name === 'channel.session') {
                if (!runtime.session) throw rpcError('CAPABILITY_DENIED')
                return runtime.session(session)
              }
              // Session effects reach handlers only after native command-journal admission.
              if (!runtime.binding) throw rpcError('CAPABILITY_DENIED')
              return runtime.binding(
                capability.name === 'channel.bind' ? 'bind' : 'unbind',
                input as { instanceId: string; targetId?: string; expectedVersion: number },
                session,
              )
            },
          })
      }
      const describe = () => {
        row.assert()
        const activation = deps.channelCurrent?.(row.owner, row.integrity, row.revision)
        return {
          extension: row.owner,
          packageId: row.origin.packageId,
          rowId: row.origin.rowId,
          revision: typeof activation === 'string' ? `${row.revision}:${activation}` : row.revision,
          manifest: registered.manifest,
          configSchema: registered.configSchema ?? { type: 'object', properties: {} },
          bindingAvailable,
        } as unknown as import('@agnes/protocol').JsonValue
      }
      row.fiber.effect(() => {
        deps.channelDirectory?.set(row.owner, describe)
        return () => {
          if (deps.channelDirectory?.get(row.owner) === describe) deps.channelDirectory.delete(row.owner)
        }
      }, 'channel.directory')
      return handle
    },
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
        recoveries.has(definition) ? () => recoveries.get(definition)!(handle.configuration(),
          ownedStore(deps.namespace(row.owner, `managed:${definition.id}`), row.assert, false)) : undefined,
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
