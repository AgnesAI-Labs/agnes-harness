import { EventEmitter } from 'node:events'
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { PLUGIN_STREAM_OPEN_PATH } from '@agnes/protocol'
import type { Client } from '@agnes/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { pluginStreamProxy } from './plugin-stream-proxy.js'

vi.mock('node:http', () => ({ request: vi.fn() }))
afterEach(() => vi.clearAllMocks())

function fixture(cancel?: 'initialize' | 'roster' | 'endpoint') {
  const origin = 'http://127.0.0.1:4180'
  const digest = `sha256-${'0'.repeat(64)}`
  const body = {
    owner: 'sample/plugin',
    name: 'browser.frames',
    client: { rowId: 'web:sample/plugin', revision: 'one', contentDigest: digest },
    scope: { kind: 'session', profileId: 'local-dev', sessionId: 'synthetic-session', laneId: 'main' },
    input: { pageId: 'synthetic-page' },
  }
  const row = {
    ...body.client,
    moduleName: body.owner,
    enabled: true,
    phase: 'ready',
    streams: ['browser.frames'],
    binding: { availability: 'active', profileId: 'local-dev' },
  }
  const request = {
    url: PLUGIN_STREAM_OPEN_PATH,
    method: 'POST',
    headers: {
      host: '127.0.0.1:4180',
      origin,
      'content-type': 'application/json',
      'x-agnes-stream-open': '1',
    },
    resume: vi.fn(),
  } as unknown as IncomingMessage
  const response = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    writeHead: vi.fn(),
    end: vi.fn(),
  })
  response.writeHead.mockReturnValue(response)
  const close = (phase: typeof cancel) => {
    if (cancel === phase) response.destroyed = true
  }
  const client = {
    clientModules: {
      list: vi.fn(async () => {
        close('roster')
        return { rows: [row] }
      }),
    },
    call: vi.fn(async () => {
      close('endpoint')
      return { host: '127.0.0.1', port: 60000, proof: 'synthetic-worker-proof' }
    }),
  }
  const proxy = pluginStreamProxy({
    client: client as unknown as Client,
    origin,
    profile: 'local-dev',
    initialize: async () => {
      close('initialize')
    },
    body: async () => body,
  })
  const upstream = { setTimeout: vi.fn(), on: vi.fn(), end: vi.fn((_body?: string) => {}), destroy: vi.fn() }
  vi.mocked(httpRequest).mockReturnValue(upstream as unknown as ReturnType<typeof httpRequest>)
  return {
    proxy,
    request,
    response,
    row,
    upstream,
    handle: () => proxy.handleHttp(request, response as unknown as ServerResponse),
  }
}

it.each(['initialize', 'roster', 'endpoint'] as const)(
  'does not admit an abandoned display request after %s',
  async (phase) => {
    const f = fixture(phase)
    try {
      expect(await f.handle()).toBe(true)
      expect(httpRequest).not.toHaveBeenCalled()
      expect(f.response.writeHead).not.toHaveBeenCalled()
      expect(f.response.end).not.toHaveBeenCalled()
    } finally {
      f.proxy.close()
    }
  },
)

it('forwards a current admitted row while retaining private proof on the backend hop', async () => {
  const f = fixture()
  try {
    expect(await f.handle()).toBe(true)
    expect(httpRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        host: '127.0.0.1',
        port: 60000,
        headers: expect.objectContaining({ 'x-agnes-stream-proof': 'synthetic-worker-proof' }),
      }),
      expect.any(Function),
    )
    expect(JSON.parse(String(f.upstream.end.mock.calls[0]?.[0]))).toMatchObject({
      owner: 'sample/plugin',
      scope: { sessionId: 'synthetic-session' },
    })
    expect(f.response.end).not.toHaveBeenCalled()
  } finally {
    f.proxy.close()
  }
})

it.each(['revision', 'digest', 'disabled', 'activation'] as const)(
  'refuses a stale or unavailable row: %s',
  async (kind) => {
    const f = fixture()
    if (kind === 'revision') f.row.revision = 'changed'
    if (kind === 'digest') f.row.contentDigest = `sha256-${'1'.repeat(64)}`
    if (kind === 'disabled') f.row.enabled = false
    if (kind === 'activation') f.row.binding.availability = 'inactive'
    try {
      expect(await f.handle()).toBe(true)
      expect(httpRequest).not.toHaveBeenCalled()
      expect(f.response.writeHead).toHaveBeenCalledWith(403, expect.any(Object))
    } finally {
      f.proxy.close()
    }
  },
)
