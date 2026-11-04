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
    const burst = Array.from({ length: 20 }, (_, seq) =>
      client.request({
        type: 'input',
        pageId: 'one',
        input: { type: 'hover', x: 50, y: 50, seq },
      }),
    )
    await vi.advanceTimersByTimeAsync(1000)
    expect(connections[0]!.sent.length).toBeLessThanOrEqual(30)
    expect(
      connections[0]!.sent.reduce(
        (bytes, frame) => bytes + new TextEncoder().encode(JSON.stringify(frame)).length,
        0,
      ),
    ).toBeLessThan(4096)
    await vi.advanceTimersByTimeAsync(1000)
    for (const frame of connections[0]!.sent) connections[0]!.receive({ id: frame.id, status: 'ok' })
    await Promise.all(burst)
    // 4 KiB is a per-frame limit, not a per-second quota. Pasting a valid
    // Chinese string must not stall the following key for a full second.
    const beforePaste = connections[0]!.sent.length
    const paste = client.request({
      type: 'input',
      pageId: 'one',
      input: { type: 'text', text: '字'.repeat(1000) },
    })
    const key = client.request({ type: 'input', pageId: 'one', input: { type: 'key', key: 'ArrowLeft' } })
    const edits = Promise.all([paste, key])
    void edits.catch(() => {})
    await vi.advanceTimersByTimeAsync(500)
    expect(connections[0]!.sent.length).toBe(beforePaste + 2)
    for (const frame of connections[0]!.sent.slice(beforePaste))
      connections[0]!.receive({ id: frame.id, status: 'ok' })
    await edits
    const action = client.request({ type: 'input', pageId: 'one', input: { type: 'text', text: '测试' } })
    await vi.advanceTimersByTimeAsync(22_000)
    expect(connections).toHaveLength(1)
    const first = connections[0]!
    first.receive({ id: first.sent.at(-1)!.id, status: 'ok', result: { pageEpoch: 0 } })
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
