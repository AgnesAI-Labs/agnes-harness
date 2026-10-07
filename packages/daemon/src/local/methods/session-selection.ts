import {
  type ConfigurationService,
  createAdminSessionSelection,
  type Host,
  type SessionDefaultsConfigurationService,
} from '@agnes/host'
import {
  type AdminLoop,
  type AdminModelAdapter,
  type AdminSessionSelection,
  isAdminModelAdapter,
  type RuntimeAdminSnapshot,
  rpcError,
  type SessionDefaultsSnapshot,
} from '@agnes/protocol'
import type { PackageAdminAuthorityResolver } from '../../packages/permissions.js'
import type { LocalEndpoint } from '../endpoint.js'

type Catalog = {
  presets?: readonly { id: string; isDefault: boolean }[]
  loops: readonly AdminLoop[]
  modelAdapters: readonly AdminModelAdapter[]
}

/** The supervisor queries its real Host-bearing shared worker, never a profile-only approximation. */
export function sessionSelectionProvider(
  configuration: ConfigurationService | undefined,
  catalog: () => Promise<Catalog>,
): AdminSessionSelection | undefined {
  if (!configuration || !('sessionDefaults' in configuration) || !('saveSessionDefaults' in configuration))
    return undefined
  return createAdminSessionSelection(
    {
      presets: async () => (await catalog()).presets?.map((entry) => entry.id) ?? [],
      loops: async () => (await catalog()).loops,
      modelAdapters: async () =>
        (await catalog()).modelAdapters.map((entry) => ({ ...entry, wireApi: entry.wireApi ?? entry.api })),
      models: async (adapter) => (isAdminModelAdapter(adapter) ? adapter.models : []),
    },
    configuration as ConfigurationService & SessionDefaultsConfigurationService,
  )
}

export async function hostSessionCatalog(host: Host): Promise<Catalog> {
  const models = host.provider.models()
  return {
    presets: host.profile.presets.allowed.map((id) => ({
      id,
      isDefault: id === host.profile.presets.default,
    })),
    loops: host.kernel.loops.catalog(),
    modelAdapters: host.modelAdapterCatalog().map((entry) => ({
      ...entry,
      models: models
        .filter((model) => model.api === entry.wireApi)
        .map((model) => ({ id: model.id, route: model.route })),
    })),
  }
}

/** Reuse server-established package admin grants; a roster-only browser grant never permits defaults. */
export function registerSessionSelection(
  endpoint: LocalEndpoint,
  provider: AdminSessionSelection | undefined,
  authority: PackageAdminAuthorityResolver,
  runtime?: {
    snapshot(): Promise<RuntimeAdminSnapshot>
    reloadLocal(): Promise<void>
  },
): void {
  const invoke = async <T>(
    context: Parameters<PackageAdminAuthorityResolver>[0],
    write: boolean,
    action: (service: AdminSessionSelection) => Promise<T>,
  ): Promise<T> => {
    const grant = authority(context)
    if (
      !grant ||
      grant.methods !== undefined ||
      !grant.permissions.includes(write ? 'packages.activate' : 'packages.read')
    )
      throw rpcError('CAPABILITY_DENIED', { reason: 'session selection requires package administration' })
    if (!provider) throw rpcError('CAPABILITY_DENIED', { reason: 'configuration unavailable' })
    try {
      return await action(provider)
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
      throw rpcError('SEMANTIC_REJECTED', {
        reason: typeof code === 'string' && /^CONFIG_[A-Z_]{1,48}$/.test(code) ? code : 'CONFIG_FAILED',
      })
    }
  }
  endpoint.register('_agnes/v1/sessionSelection.loops', (_params, ctx) =>
    invoke(ctx, false, async (s) => ({
      loops: await s.loops(),
      ...(s.presets ? { presets: await s.presets() } : {}),
    })),
  )
  endpoint.register('_agnes/v1/sessionSelection.modelAdapters', (_params, ctx) =>
    invoke(ctx, false, async (s) => ({ modelAdapters: await s.modelAdapters() })),
  )
  endpoint.register('_agnes/v1/sessionSelection.defaults.get', (_params, ctx) =>
    invoke(ctx, false, (s) => s.getDefaults()),
  )
  endpoint.register('_agnes/v1/sessionSelection.defaults.save', (params, ctx) =>
    invoke(ctx, true, (s) => s.saveDefaults(params as SessionDefaultsSnapshot)),
  )
  const runtimeCall = async (ctx: Parameters<PackageAdminAuthorityResolver>[0], write: boolean) => {
    const grant = authority(ctx)
    if (
      !grant ||
      grant.methods !== undefined ||
      !grant.permissions.includes(write ? 'packages.activate' : 'packages.read')
    )
      throw rpcError('CAPABILITY_DENIED')
    if (!runtime) throw rpcError('CAPABILITY_DENIED', { reason: 'runtime administration unavailable' })
    if (!write) return runtime.snapshot()
    await runtime.reloadLocal()
    return {}
  }
  endpoint.register('_agnes/v1/sessionSelection.runtime', (_params, ctx) => runtimeCall(ctx, false))
  endpoint.register('_agnes/v1/sessionSelection.reloadLocal', (_params, ctx) => runtimeCall(ctx, true))
}
