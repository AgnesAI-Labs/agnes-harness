import type { TriggerSessionInput } from '@agnes/daemon-admin/webhooks'
import { createClient, memoryJournal, type NodeClient } from '@agnes/sdk'

/** Use the same private local SDK path as chat, including workspace ownership and turn admission. */
export function webhookSessions(socketPath: string, serverIdentity: { pid: number; processStartId: string }, enqueue: (value: TriggerSessionInput) => Promise<void>) {
  const clients = new Set<NodeClient>()
  let closing = false
  const connect = () =>
    createClient({
      transport: {
        kind: 'unix',
        path: socketPath,
        ...(socketPath.startsWith('\\\\.\\pipe\\') ? { serverIdentity } : {}),
      },
      auth: { kind: 'local' },
      journal: memoryJournal('webhook-triggers'),
    })
  return {
    async create(input: TriggerSessionInput) {
      if (closing) throw new Error('Webhook session admission closed')
      const client = connect()
      clients.add(client)
      try {
        await client.initialize()
        await client.createSession({
          cwd: input.workspace,
          preset: input.agent,
          bundles: input.bundles,
          sessionKey: input.sessionKey,
        })
        // Enqueue is durable before acceptance; run uses the ordinary Core/worker policy.
        await enqueue(input)
      } finally {
        // Admission is durable; closing this transport does not cancel the ordinary session.
        // A client per delivery also bounds SDK handles and journal entries over daemon uptime.
        await client.close().finally(() => clients.delete(client))
      }
    },
    async close() {
      closing = true
      await Promise.all([...clients].map((client) => client.close()))
    },
  }
}
