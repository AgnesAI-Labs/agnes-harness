import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { LocalEndpoint, type RpcEndpoint } from '../src/local/endpoint.js'
import { bindConnection } from '../src/supervisor/connection.js'
import { encodeFrame, JsonlDecoder } from '../src/supervisor/framing.js'
import { listenUnix } from '../src/supervisor/socket.js'
import { openTestHost, say } from './host.js'
import { localSocketPath } from './local-socket-path.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
const init = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } },
}
async function wire(ep: RpcEndpoint) {
  const root = mkdtempSync(join(tmpdir(), 'agnes-wire-'))
  let closed: Promise<void> | undefined
  let closes = 0
  const server = await listenUnix(localSocketPath(join(root, 'd.sock')), (s) => {
    closed = bindConnection(s, ep, {
      onClose() {
        closes++
      },
    }).closed
  })
  const client = connect(localSocketPath(join(root, 'd.sock')))
  const decoder = new JsonlDecoder()
  const frames: unknown[] = []
  const waiting: Array<(v: unknown) => void> = []
  client.on('data', (bytes: Buffer) => {
    for (const frame of decoder.feed(bytes)) {
      frames.push(frame)
      waiting.shift()?.(frame)
    }
  })
  client.on('error', () => {})
  await once(client, 'connect')
  cleanups.push(async () => {
    client.destroy()
    await server.close()
    await closed
    rmSync(root, { recursive: true, force: true })
  })
  let cursor = 0
  const next = async (): Promise<Record<string, unknown>> => {
    const frame =
      cursor < frames.length ? frames[cursor] : await new Promise<unknown>((resolve) => waiting.push(resolve))
    cursor++
    return frame as Record<string, unknown>
  }
  const response = async (id: number) => {
    for (;;) {
      const f = await next()
      if (f.id === id) return f
    }
  }
  return { client, next, response, frames, closeCount: () => closes }
}
function endpoint() {
  const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
  ep.register('initialize', async (_, cx) => {
    cx.conn.initialized = true
    return { protocolVersion: 1, agentCapabilities: {} }
  })
  return ep
}
it('runs initialize/new/prompt through real socket, LocalEndpoint, Host and core', async () => {
  const h = await openTestHost({ script: [say('socket answer')] })
  cleanups.push(h.close)
  const w = await wire(h.endpoint({ pollMs: 5 }))
  w.client.write(encodeFrame(init))
  expect(await w.response(1)).toMatchObject({ result: { protocolVersion: 1 } })
  w.client.write(
    encodeFrame({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: h.dataDir, mcpServers: [] } }),
  )
  const created = await w.response(2)
  const sessionId = (created.result as { sessionId: string }).sessionId
  w.client.write(
    encodeFrame({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'hi' }] },
    }),
  )
  expect(await w.response(3)).toMatchObject({ result: { stopReason: 'end_turn' } })
  expect(JSON.stringify(w.frames)).toContain('socket answer')
})
it('routes a reverse permission reply while its originating handler is still pending', async () => {
  const ep = endpoint()
  ep.register('_agnes/v1/apis.list', async () => {
    const answer = await ep.request('session/request_permission', {
      sessionId: 's',
      toolCall: { toolCallId: 't' },
      options: [],
    })
    expect(answer).toEqual({ accepted: true })
    return {
      profile: { name: 'local', resolvedProfileHash: null, presets: { default: 'p', allowed: ['p'] } },
      families: [],
    }
  })
  const w = await wire(ep)
  w.client.write(encodeFrame(init))
  await w.response(1)
  w.client.write(encodeFrame({ jsonrpc: '2.0', id: 2, method: '_agnes/v1/apis.list', params: {} }))
  const ask = await w.next()
  expect(ask.method).toBe('session/request_permission')
  w.client.write(encodeFrame({ jsonrpc: '2.0', id: ask.id, result: { accepted: true } }))
  expect(await w.response(2)).toMatchObject({ result: { families: [] } })
  expect(ep.pendingRequests()).toBe(0)
})
it.each([
  '{\n',
  'null\n',
  '{"jsonrpc":"1.0","id":1,"method":"initialize"}\n',
  '{"jsonrpc":"2.0","id":null,"method":"initialize"}\n',
])('flushes fixed errors and closes malformed input %j', async (input) => {
  const w = await wire(endpoint())
  const ended = once(w.client, 'close')
  w.client.write(input)
  expect(await w.next()).toMatchObject({ id: null, error: { code: input === '{\n' ? -32700 : -32600 } })
  await ended
})
it('enforces the default 1000 in-flight message limit on actual socket traffic', async () => {
  const ep = endpoint()
  ep.register('_agnes/v1/apis.list', () => new Promise(() => {}))
  const w = await wire(ep)
  w.client.write(encodeFrame(init))
  await w.response(1)
  const ended = once(w.client, 'close')
  for (let n = 0; n < 1001; n++)
    w.client.write(encodeFrame({ jsonrpc: '2.0', id: n + 2, method: '_agnes/v1/apis.list', params: {} }))
  expect(await w.next()).toMatchObject({ error: { code: -32001 } })
  await ended
})

it('rejects an outbound frame over the default 8MiB write buffer cap on a real socket', async () => {
  const ep = endpoint(),
    w = await wire(ep)
  const ended = once(w.client, 'close')
  ep.push({ jsonrpc: '2.0', method: 'test/large', params: { text: 'x'.repeat(8 * 1024 * 1024) } })
  expect(await w.next()).toMatchObject({ error: { code: -32001 } })
  await ended
})
