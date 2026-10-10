import type { ConfigurationService } from '@agnes/host'
import {
  type ConfigAccountInput,
  type ConfigOAuthInput,
  type ConfigSaveInput,
  type ConfigSnapshot,
  type ConfigTestInput,
  type JevConfigSaveInput,
  type JevConfigTestInput,
  rpcError,
} from '@agnes/protocol'
import type { CallContext, LocalEndpoint } from '../endpoint.js'

/** Configuration is deployment-local authority, not a capability granted by an RPC parameter. */
export function registerConfiguration(
  endpoint: LocalEndpoint,
  service?: ConfigurationService,
  applied?: (snapshot: ConfigSnapshot) => Promise<ConfigSnapshot>,
  present?: (snapshot: ConfigSnapshot) => ConfigSnapshot,
): void {
  let restartRevision: number | undefined
  const status = (snapshot: ConfigSnapshot): ConfigSnapshot =>
    present
      ? present(snapshot)
      : restartRevision === snapshot.revision
        ? { ...snapshot, effect: 'restart-required' }
        : snapshot
  const invoke = async <T>(
    context: CallContext,
    action: (configuration: ConfigurationService) => Promise<T>,
  ): Promise<T> => {
    if (context.conn.authKind !== 'local' || context.conn.credentialKind !== 'local')
      throw rpcError('CAPABILITY_DENIED', { method: 'config', reason: 'local configuration only' })
    if (!service)
      throw rpcError('CAPABILITY_DENIED', { method: 'config', reason: 'configuration unavailable' })
    try {
      return await action(service)
    } catch (error) {
      // Never forward an upstream body, URL, path or credential through a setup failure.
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
      const reason = typeof code === 'string' && /^CONFIG_[A-Z_]{1,48}$/.test(code) ? code : 'CONFIG_FAILED'
      throw rpcError('SEMANTIC_REJECTED', { reason })
    }
  }
  endpoint.register('_agnes/v1/config.get', (_params, context) =>
    invoke(context, async (s) => status(await s.get())),
  )
  endpoint.register('_agnes/v1/config.providers', (_params, context) => invoke(context, (s) => s.providers()))
  endpoint.register('_agnes/v1/config.test', (params, context) =>
    invoke(context, (s) => s.test(params as ConfigTestInput)),
  )
  const apply = async (snapshot: ConfigSnapshot): Promise<ConfigSnapshot> => {
    let result: ConfigSnapshot
    try {
      result = applied ? await applied(snapshot) : { ...snapshot, effect: 'restart-required' }
    } catch {
      result = { ...snapshot, effect: 'restart-required' }
    }
    restartRevision = result.effect === 'restart-required' ? result.revision : undefined
    return result
  }
  endpoint.register('_agnes/v1/config.save', (params, context) =>
    invoke(context, async (s) => apply(await s.save(params as ConfigSaveInput))),
  )
  endpoint.register('_agnes/v1/config.account', (params, context) =>
    invoke(context, async (s) => apply(await s.account(params as ConfigAccountInput))),
  )
  const jev = <T>(
    context: CallContext,
    action: (service: NonNullable<ConfigurationService['jev']>) => Promise<T>,
  ) =>
    invoke(context, (s) => {
      if (!s.jev) throw Object.assign(new Error('CONFIG_UNAVAILABLE'), { code: 'CONFIG_UNAVAILABLE' })
      return action(s.jev)
    })
  endpoint.register('_agnes/v1/config.jevGet', (_params, context) => jev(context, (s) => s.get()))
  endpoint.register('_agnes/v1/config.jevTest', (params, context) =>
    jev(context, (s) => s.test(params as JevConfigTestInput)),
  )
  endpoint.register('_agnes/v1/config.jevSave', (params, context) =>
    jev(context, (s) => s.save(params as JevConfigSaveInput)),
  )
  endpoint.register('_agnes/v1/config.oauth', (params, context) =>
    invoke(context, async (service) => {
      if (!service.oauth)
        throw Object.assign(new Error('CONFIG_AUTH_UNAVAILABLE'), { code: 'CONFIG_AUTH_UNAVAILABLE' })
      const result = await service.oauth(params as ConfigOAuthInput, context.conn, context.signal)
      return result.snapshot ? { ...result, snapshot: await apply(result.snapshot) } : result
    }),
  )
}
