import type { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import type { RefinementSettingsStore } from '@agnes/host'
import {
  type RefinementSettingsSaveParams,
  type RefinementSettingsSaveResult,
  type RefinementSettingsSnapshot,
  rpcError,
} from '@agnes/protocol'

const errorCode = (error: unknown): string | undefined => (error as { code?: string } | null)?.code

/** The refinement switch of the daemon's profile: local callers only, saved by compare-and-swap. */
export function registerRefinement(
  ep: LocalEndpoint,
  deps: { settings: Pick<RefinementSettingsStore, 'read' | 'save'> },
): void {
  // The same guard as `config.*` and `voice.settings.*`: settings are local profile configuration.
  const local = (c: Parameters<Parameters<LocalEndpoint['register']>[1]>[1]) => {
    if (c.conn.authKind !== 'local' || c.conn.credentialKind !== 'local')
      throw rpcError('CAPABILITY_DENIED', {
        method: 'refinement.settings',
        reason: 'local configuration only',
      })
  }
  const stored = <T>(action: () => T): T => {
    try {
      return action()
    } catch (error) {
      const code = errorCode(error)
      if (code === 'CONFIG_REVISION_CONFLICT' || code === 'CONFIG_INVALID_INPUT')
        throw rpcError('SEMANTIC_REJECTED', { reason: code })
      throw rpcError('INTERNAL_ERROR', { reason: 'refinement settings unavailable' })
    }
  }
  ep.register('_agnes/v1/refinement.get', async (_params, c): Promise<RefinementSettingsSnapshot> => {
    local(c)
    return stored(() => deps.settings.read())
  })
  ep.register('_agnes/v1/refinement.save', async (params, c): Promise<RefinementSettingsSaveResult> => {
    local(c)
    const p = params as RefinementSettingsSaveParams
    return stored(() => deps.settings.save(p.settings, p.expectedRevision))
  })
}
