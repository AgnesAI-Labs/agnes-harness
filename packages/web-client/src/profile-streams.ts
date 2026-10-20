import type { JsonValue } from '@agnes/protocol'
import { createPluginStreamsClient } from '@agnes/sdk/browser'
import { type ContributionAvailability, ownContribution } from './contribution-scope.js'
import type { ModuleIdentity } from './service-contracts.js'

/** Profile identity and stream names come only from the accepted daemon roster.
 * Owner revocation aborts pending opens and live streams before asynchronous fiber teardown. */
export function scopedProfileStreams(
  module: ModuleIdentity,
  availability: ContributionAvailability,
  effect: (off: () => void) => void,
  session?: import('./services-session.js').SessionService,
) {
  const lifetime = new AbortController()
  const binding = module.binding
  const names = [...(module.streams ?? [])]
  ownContribution(binding?.owner ?? module.rowId ?? module.packageId, () => lifetime.abort(), effect)
  return Object.freeze({
    async open(
      name: string,
      input: JsonValue,
      options: { signal?: AbortSignal; controlOperationId?: string } = {},
    ) {
      const current = availability.getSnapshot()
      const selected = session?.readiness.getSnapshot()
      if (session && (selected?.status !== 'ready' || !selected.sessionId))
        throw new Error('session stream requires a ready session')
      if (
        lifetime.signal.aborted ||
        !binding ||
        binding.lifetime !== 'profile' ||
        current?.availability !== 'active' ||
        current.activationId !== binding.activationId ||
        !module.rowId ||
        !module.contentDigest ||
        !module.backendOwner ||
        !names.includes(name)
      )
        throw new Error('profile stream is unavailable')
      const connection = new AbortController()
      const off = session?.readiness.subscribe(() => {
        if (session.readiness.getSnapshot().epoch !== selected?.epoch) connection.abort()
      })
      const signal = AbortSignal.any([
        lifetime.signal,
        connection.signal,
        ...(options.signal ? [options.signal] : []),
      ])
      try {
        const stream = await createPluginStreamsClient({
          origin: globalThis.location.origin,
          owner: module.backendOwner,
          client: { rowId: module.rowId, revision: module.revision, contentDigest: module.contentDigest },
          scope: selected?.sessionId
            ? { kind: 'session', profileId: binding.profileId, sessionId: selected.sessionId, laneId: 'main' }
            : { kind: 'profile', profileId: binding.profileId },
          names,
          signal,
        }).open(name, input, options)
        stream.onDisconnect(() => off?.())
        return stream
      } catch (error) {
        off?.()
        throw error
      }
    },
  })
}
