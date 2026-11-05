import type { Host } from '@agnes/host'
import { rpcError } from '@agnes/protocol'

export function newSessionActorResolver(profile: Host['profile']): Host['resolveActor'] {
  return profile.seams?.principals?.provider === 'local'
    ? async (_credential, surface) => ({
        id: 'local',
        org: 'local',
        role: 'owner',
        deptPath: [],
        attrs: { surface },
      })
    : async () => {
        throw rpcError('CAPABILITY_DENIED', {
          method: 'session/new',
          reason: 'new session actor authority unavailable',
        })
      }
}
