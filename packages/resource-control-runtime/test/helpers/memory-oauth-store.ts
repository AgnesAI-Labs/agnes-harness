import type { McpOAuthNext, McpOAuthRead, McpOAuthRecord, McpOAuthStore } from '../../src/mcp-oauth-store.js'

export type MemoryOAuthStore = McpOAuthStore &
  Readonly<{
    /** Puts a record in directly, as if another process had written it (rev is taken as given). */
    seed(serverId: string, value: McpOAuthRead): void
    /** Number of writes `update` has made, to assert "no write happened". */
    writes(serverId: string): number
  }>

/**
 * In-memory stand-in for the host credential store with the same contract: one lock per server,
 * `update` re-reads inside the lock, writes only when `change` returns `next`, and always sets
 * `rev` to the previous value plus one (the caller can never choose it).
 */
export function createMemoryOAuthStore(initial: Record<string, McpOAuthRead> = {}): MemoryOAuthStore {
  const values = new Map<string, McpOAuthRead>(Object.entries(initial))
  const tails = new Map<string, Promise<unknown>>()
  const writeCounts = new Map<string, number>()

  const rev = (value: McpOAuthRead | undefined): number => (value && !('legacy' in value) ? value.rev : 0)

  return {
    seed(serverId, value) {
      values.set(serverId, value)
    },
    writes(serverId) {
      return writeCounts.get(serverId) ?? 0
    },
    async read(serverId) {
      return values.get(serverId) ?? null
    },
    update<T>(
      serverId: string,
      change: (current: McpOAuthRead) => Promise<Readonly<{ value: T; next?: McpOAuthNext }>>,
    ): Promise<T> {
      const previous = tails.get(serverId) ?? Promise.resolve()
      const run = previous
        .catch(() => undefined)
        .then(async () => {
          const current = values.get(serverId) ?? null
          const result = await change(current)
          if (result.next) {
            const written: McpOAuthRecord = {
              ...result.next,
              version: 2,
              kind: 'oauth',
              rev: rev(current) + 1,
            }
            values.set(serverId, written)
            writeCounts.set(serverId, (writeCounts.get(serverId) ?? 0) + 1)
          }
          return result.value
        })
      tails.set(serverId, run)
      return run
    },
  }
}
