import { rpcError } from '@agnes/protocol'

const INTERNAL = rpcError('INTERNAL_ERROR').code

/** Session ports refuse new work once the daemon closes them; like a closed transport, it says nothing about a gate. */
export class ManagedPortsClosed extends Error {
  readonly kind = 'transport-closed'
  constructor() {
    super('managed session admission closed')
    this.name = 'ManagedPortsClosed'
  }
}

/**
 * Whether a failed gate read is an answer: an RPC error the daemon gave, or a domain failure the
 * shared worker replied with, such as an unknown agent or a bundle that is not installed, enabled
 * and trusted. A failure raised on this side of the link is not one: the link to the worker closed
 * or timed out, the worker could not be started, the local client's transport closed, or the
 * session ports are closed. Nor is an internal error or the worker's generic failure.
 */
export function gateRefused(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const value = error as { kind?: unknown; code?: unknown }
  if (error instanceof Error && value.kind !== 'json-rpc') return false
  if (typeof value.code === 'number') return value.code !== INTERNAL
  return typeof value.code === 'string' && value.code !== 'E_WORKER'
}

/**
 * The shared worker's reads the managed-session gates use, straight over the daemon's link to it, so
 * a link failure stays distinguishable from the worker's answer. Each read is bounded; a timeout is a
 * link failure, not an answer.
 */
export function sharedWorkerReads(pool: {
  acquireSharedWorker(): Promise<{
    command(
      method: string,
      params: Record<string, unknown>,
      options?: { timeoutMs?: number },
    ): Promise<unknown>
  }>
}) {
  return {
    catalog: async () =>
      (await (await pool.acquireSharedWorker()).command('session.catalog', {}, { timeoutMs: 31_000 })) as {
        modelAdapters: readonly { models: readonly { id: string; route: string }[] }[]
        security?: { platform?: { l1?: { level?: string } } }
      },
    resolveAgent: async (ref: string): Promise<void> =>
      void (await (
        await pool.acquireSharedWorker()
      ).command('agents.resolve', { ref }, { timeoutMs: 31_000 })),
  }
}
