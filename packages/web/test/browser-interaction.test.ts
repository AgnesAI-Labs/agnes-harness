import type { ClientContext } from '@agnes/web-client'
import { expect, it, vi } from 'vitest'
import { BrowserInteraction } from '../../package-manager/bundled-plugins/browser/src/browser-interaction.js'

it('prepares once, drains acknowledgements before renewal, and never replays disconnected input', async () => {
  vi.useFakeTimers()
  const connections: { receive(value: object): void; disconnect(): void; sent: Record<string, unknown>[] }[] =
    []
  const effect = vi.fn(async () => ({ status: 'ok' }))
  const open = vi.fn(async () => {
    const connection = { receive(_value: object) {}, disconnect() {}, sent: [] as Record<string, unknown>[] }
    connections.push(connection)
    return {
      onFrame(fn: typeof connection.receive) {
        connection.receive = fn
      },
      onDisconnect(fn: () => void) {
        connection.disconnect = fn
      },
      close() {
        connection.disconnect()
      },
      send(value: Record<string, unknown>) {
        connection.sent.push(value)
        return 'accepted'
      },
    }
  })
  const client = new BrowserInteraction({
    sessionStreams: { open },
    agnes: { services: { effect } },
  } as unknown as ClientContext)
  try {
    await Promise.all([client.prepare(), client.prepare()])
    expect(effect).toHaveBeenCalledTimes(1)
    const action = client.request({ type: 'input', pageId: 'one', input: { type: 'text', text: '测试' } })
    await vi.advanceTimersByTimeAsync(22_000)
    expect(connections).toHaveLength(1)
    const first = connections[0]!
    first.receive({ id: first.sent[0]!.id, status: 'ok', result: { pageEpoch: 0 } })
    await expect(action).resolves.toMatchObject({ pageEpoch: 0 })
    await vi.advanceTimersByTimeAsync(100)
    expect(connections).toHaveLength(2)
    expect(effect).toHaveBeenCalledTimes(1)
    const next = client.request({ type: 'input', pageId: 'one', input: { type: 'key', key: 'Enter' } })
    const refusal = expect(next).rejects.toThrow('not retried')
    await vi.advanceTimersByTimeAsync(0)
    connections[1]!.disconnect()
    await refusal
    await vi.advanceTimersByTimeAsync(60_000)
    expect(connections).toHaveLength(2)
    expect(connections[1]!.sent).toHaveLength(1)
    client.close()
    await expect(client.request({ type: 'view' })).rejects.toThrow()
  } finally {
    client.close()
    vi.useRealTimers()
  }
})
