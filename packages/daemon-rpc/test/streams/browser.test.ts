import { createStreamChannel } from '@agnes/plugin-streams'
import { decodePluginStreamBinary } from '@agnes/protocol'
import { expect, it, vi } from 'vitest'

const { BrowserRuntime } = await import(
  new URL('../../../package-manager/bundled-plugins/browser-runtime/src/runtime.mjs', import.meta.url).href
)
const { stream: declaration } = await import(
  new URL('../../../package-manager/bundled-plugins/browser-runtime/src/contracts.mjs', import.meta.url).href
)

it('carries browser pictures above the JSON limit through the real media channel without reconnecting', async () => {
  let upstream!: EventTarget
  class Socket extends EventTarget {
    constructor() {
      super()
      upstream = this
    }
    close() {}
  }
  vi.stubGlobal('WebSocket', Socket)
  const signal = new AbortController().signal
  const runtime = new BrowserRuntime({
    start: async () => ({
      port: 1234,
      call: async () => ({}),
      close: async () => {},
      exited: new Promise(() => {}),
    }),
  })
  const frames: Uint8Array[] = []
  const close = vi.fn()
  const channel = createStreamChannel({
    id: 1,
    declaration,
    signal,
    assertCurrent() {},
    mediaBudget: () => true,
    profileBuffered: () => 0,
    now: Date.now,
    released() {},
    socket: {
      bufferedAmount: 0,
      close,
      send(data, done) {
        if (data instanceof Uint8Array) frames.push(decodePluginStreamBinary(data).payload)
        done()
      },
    },
  })
  try {
    await runtime.execute(
      { action: 'open', url: 'https://example.com' },
      {
        session: { key: 'one', lane: 'main' },
        signal,
      },
    )
    const actor = { kind: 'human', id: 'synthetic' }
    runtime.watch(runtime.observe('one', actor).ticket, {
      actor,
      signal: channel.signal,
      stream: channel.stream,
    })
    const picture = Buffer.alloc(32000, 0x55)
    picture.set([0xff, 0xd8])
    for (let i = 0; i < 3; i++)
      upstream.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'frame', data: picture.toString('base64') }),
        }),
      )
    expect(close).not.toHaveBeenCalled()
    expect(frames).toHaveLength(3)
    expect(Buffer.from(frames[0] ?? [])).toEqual(picture)
  } finally {
    await runtime.dispose()
    channel.disconnect('closed')
    vi.unstubAllGlobals()
  }
})
