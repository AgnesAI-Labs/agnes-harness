import type { CallContext } from '@agnes/extension-api/runtime'
import type { JsonValue } from '@agnes/protocol/runtime'

export interface McpSession {
  request(method: string, params: JsonValue, context: CallContext): Promise<JsonValue>
  readonly alive: boolean
  close(): Promise<void>
}
type Lease = { session: McpSession; owners: Set<string> }

/** In-memory ownership only. Persistent resource/package pins belong to the assembly owner. */
export function createMcpLeases() {
  const sessions = new Map<string, Lease>()
  const opening = new Map<string, Promise<McpSession>>()
  return {
    async acquire(key: string, ownerId: string, open: () => Promise<McpSession>) {
      let lease = sessions.get(key)
      if (!lease?.session.alive) {
        let pending = opening.get(key)
        if (!pending) {
          pending = open()
          opening.set(key, pending)
        }
        try {
          const session = await pending
          lease = sessions.get(key)
          if (!lease || lease.session !== session) {
            const owners = lease?.owners ?? new Set<string>()
            await lease?.session.close()
            lease = { session, owners }
            sessions.set(key, lease)
          }
        } finally {
          if (opening.get(key) === pending) opening.delete(key)
        }
      }
      lease.owners.add(ownerId)
      return lease.session
    },
    retain(key: string, ownerId: string): boolean {
      const lease = sessions.get(key)
      if (!lease) return false
      lease.owners.add(ownerId)
      return true
    },
    async release(key: string, ownerId: string) {
      const lease = sessions.get(key)
      if (!lease?.owners.delete(ownerId)) return
      if (!lease.owners.size) {
        sessions.delete(key)
        await lease.session.close()
      }
    },
    async releaseOwner(ownerId: string) {
      for (const [key, lease] of sessions) {
        lease.owners.delete(ownerId)
        if (!lease.owners.size) {
          sessions.delete(key)
          await lease.session.close()
        }
      }
    },
    inspect(key: string) {
      const lease = sessions.get(key)
      return lease ? { alive: lease.session.alive, owners: [...lease.owners] } : null
    },
  }
}
export type McpLeases = ReturnType<typeof createMcpLeases>
