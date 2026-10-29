import type { ClientModuleRosterRow, PluginStreamOpen } from '@agnes/protocol'
import {
  PluginStreamError,
  type StreamAdmission,
  type StreamPrincipal,
  type StreamRegistration,
} from './broker.js'

/** Consume the current profile/pinned roster projection, never a row supplied by the browser.
 * The authority owner binds session/lane/source and resolves a consumed effect operation for inbound streams.
 * Its signal must revoke when the roster, scope, connection or operation authority changes. */
export function createRosterStreamAuthorizer(options: {
  resolve(
    principal: StreamPrincipal,
    request: PluginStreamOpen,
    registration: StreamRegistration,
  ): Promise<{
    current(): ClientModuleRosterRow | undefined
    /** A separate Host runtime epoch when the contribution catalog has its own UI lifetime.
     * Must be read from current backend authority, never from browser input. */
    backendActivationId?(): string
    /** Trusted resolver may bind a current profile UI to a separately authorized session resource. */
    consumerLifetime?: 'profile' | 'session'
    signal: AbortSignal
    assertScope(): void
    control?: StreamAdmission['control']
  }>
}) {
  return async (
    principal: StreamPrincipal,
    request: PluginStreamOpen,
    registration: StreamRegistration,
  ): Promise<StreamAdmission> => {
    const selected = await options.resolve(principal, request, registration)
    const assertCurrent = () => {
      selected.signal.throwIfAborted()
      principal.signal.throwIfAborted()
      selected.assertScope()
      const row = selected.current()
      const binding = row?.binding
      if (
        !request.client ||
        !row?.enabled ||
        row.phase !== 'ready' ||
        row.rowId !== request.client.rowId ||
        row.revision !== request.client.revision ||
        row.contentDigest !== request.client.contentDigest ||
        row.moduleName !== registration.owner ||
        !row.extIds?.includes(registration.owner) ||
        !row.streams?.includes(registration.declaration.name) ||
        request.owner !== registration.owner ||
        request.name !== registration.declaration.name ||
        request.scope.kind !== registration.declaration.scope ||
        !binding ||
        binding.owner !== row.rowId ||
        binding.availability !== 'active' ||
        binding.profileId !== principal.profileId ||
        binding.profileId !== registration.profileId ||
        binding.profileId !== request.scope.profileId ||
        binding.integrity !== row.revision ||
        binding.packageId !== row.packageId ||
        !binding.activationId ||
        (selected.backendActivationId?.() ?? binding.activationId) !== registration.activationId ||
        binding.lifetime !== (selected.consumerLifetime ?? request.scope.kind) ||
        (registration.declaration.directions.includes('inbound') &&
          !registration.declaration.producer &&
          (!request.controlOperationId || !selected.control?.grantId))
      )
        throw new PluginStreamError('REFUSED')
    }
    assertCurrent()
    return {
      signal: selected.signal,
      assertCurrent,
      ...(selected.control ? { control: selected.control } : {}),
    }
  }
}
