import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createProvider, NullContractStore, PiAdapter } from '@agnes/ai'
import { FakeAdapter, fakeModel, fakeRequest } from '@agnes/ai/testkit'
import { expect, it } from 'vitest'
import { RequestTraceStore, redactRequest } from '../src/request-traces.js'

it('retains complete snapshots when separate session workers write and collect concurrently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agh-trace-workers-'))
  const script = `
    import { redactRequest, RequestTraceStore } from './packages/host-infrastructure/src/request-traces.ts';
    const [root, worker] = process.argv.slice(1);
    const store = new RequestTraceStore(root, 'local');
    const stop = store.start();
    try {
      for (let index = 0; index < 16; index++) {
        const handle = await store.begin({
          kind: 'inference', sessionKey: worker, slot: 'primary', route: 'demo', model: 'demo',
          contractId: null, derivedHash: 'a'.repeat(64), system: worker + ':' + index,
          tools: [], messages: [],
        });
        await handle.wire({ system: worker + ':' + index, messages: [] });
        handle.event({ type: 'done' });
        await handle.finish();
      }
    } finally { stop(); }
  `
  try {
    await Promise.all(
      ['one', 'two', 'three'].map((worker) =>
        promisify(execFile)(process.execPath, [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          script,
          root,
          worker,
        ]),
      ),
    )
    const reader = new RequestTraceStore(root, 'local')
    for (const worker of ['one', 'two', 'three']) {
      const calls = (await reader.get(worker)).calls ?? []
      expect(calls).toHaveLength(16)
      for (const call of calls) {
        const result = await reader.get(worker, call.id)
        expect(result.snapshot).toMatchObject({
          capture: 'final-provider-body',
          response: { status: 'done' },
        })
        expect(result.snapshot?.wire).toEqual({ system: result.snapshot?.system, messages: [] })
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

function reply(api: string): string {
  const events =
    api === 'openai-responses'
      ? [
          { type: 'response.created', response: { id: 'resp-local' } },
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: { type: 'message', id: 'msg', role: 'assistant', content: [] },
          },
          { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'local-ok' },
          {
            type: 'response.completed',
            response: {
              id: 'resp-local',
              status: 'completed',
              output: [],
              usage: { input_tokens: 11, output_tokens: 3, total_tokens: 14 },
            },
          },
        ]
      : [
          {
            type: 'message_start',
            message: {
              id: 'msg',
              type: 'message',
              role: 'assistant',
              content: [],
              model: 'm',
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 11, output_tokens: 0 },
            },
          },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'local-ok' } },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 3 },
          },
          { type: 'message_stop' },
        ]
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

it.each(['openai-responses', 'anthropic-messages'] as const)(
  '%s captures final redacted endpoint JSON for every retry and keeps cancelled/compaction calls separate',
  async (api) => {
    const root = await mkdtemp(join(tmpdir(), 'agh-trace-endpoint-'))
    const received: unknown[] = []
    let cancel = false
    let receivedCancel: (() => void) | undefined
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      received.push(JSON.parse(Buffer.concat(chunks).toString()))
      if (cancel) {
        receivedCancel?.()
        return
      }
      if (received.length === 1) {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end('{"error":{"message":"retry-local"}}')
      } else {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'x-request-id': 'req-local',
          'set-cookie': 'private-cookie',
        })
        res.end(reply(api))
      }
    })
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('No local endpoint')
      const baseUrl = `http://127.0.0.1:${address.port}`
      const adapter = new PiAdapter({
        manualRoutes: [
          {
            route: 'local',
            api,
            baseUrl,
            credentialRef: 'synthetic',
            models: [
              fakeModel({
                id: 'm',
                route: 'local',
                api,
                baseUrl,
                compat:
                  api === 'openai-responses' ? { supportsStorage: false } : { supportsToolChoice: true },
              }),
            ],
          },
        ],
        maxRetries: 1,
        sleep: async () => {},
      })
      const store = new RequestTraceStore(root, 'local', undefined, Date.now, () => ({
        generationId: 'generation-fixture',
      }))
      const provider = createProvider({
        adapters: [adapter],
        routes: { primary: { route: 'local', model: 'm' } },
        contract: new NullContractStore(),
        secrets: () => 'synthetic-credential',
        clock: Date.now,
        trace: store,
      })
      const request = fakeRequest({
        route: 'local',
        model: 'm',
        system: 'persona password=hunter2',
        sections: [{ id: 'memory', order: 1, source: 'memory:fixture', text: 'password=hunter2' }],
        traceContext: { memoryRevision: 'revision-1', compactionBoundary: 7 },
        tools: [
          {
            name: 'lookup',
            description: 'lookup',
            parameters: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query'],
              additionalProperties: false,
            },
          },
        ],
      })
      const events = []
      for await (const event of provider.infer(request, {
        signal: new AbortController().signal,
        toolNames: ['lookup'],
      }))
        events.push(event)
      expect(events.at(-1)).toMatchObject({ type: 'done' })
      expect(received).toHaveLength(2)
      const calls = (await store.get(request.sessionKey)).calls!
      expect(calls).toHaveLength(1)
      const snapshot = (await store.get(request.sessionKey, calls[0]!.id)).snapshot!
      expect(snapshot).toMatchObject({
        generationId: 'generation-fixture',
        memoryRevision: 'revision-1',
        compactionBoundary: 7,
        redacted: true,
        capture: 'final-provider-body',
      })
      expect(snapshot.memoryHash).toMatch(/^[0-9a-f]{64}$/)
      expect(snapshot.attempts).toHaveLength(2)
      expect(snapshot.attempts.map((attempt) => attempt.status)).toEqual(['failed', 'completed'])
      expect(new Set(snapshot.attempts.map((attempt) => attempt.attemptId)).size).toBe(2)
      for (const [index, attempt] of snapshot.attempts.entries()) {
        expect(attempt.parentCallId).toBe(snapshot.id)
        expect(attempt.wire).toEqual(redactRequest(received[index]))
        expect(attempt.wire).toMatchObject({
          stream: true,
          tools: [
            api === 'openai-responses'
              ? { type: 'function', name: 'lookup', parameters: request.tools[0]!.parameters }
              : {
                  name: 'lookup',
                  input_schema: {
                    type: 'object',
                    properties: { query: { type: 'string' } },
                    required: ['query'],
                  },
                },
          ],
        })
        expect(attempt.adapter).toMatchObject({ id: 'pi', version: '0.0.0', api })
        expect(attempt.adapter.endpoint).toBe(
          `${baseUrl}/${api === 'openai-responses' ? 'responses' : 'v1/messages'}`,
        )
        expect(attempt.toolSchemaHash).toMatch(/^[0-9a-f]{64}$/)
        expect(JSON.stringify(attempt)).not.toMatch(/hunter2|synthetic-credential|private-cookie/)
      }
      expect(snapshot.attempts[0]!.providerActualTokens).toBeNull()
      expect(snapshot.attempts[1]!.providerActualTokens).toMatchObject({ input: 11, output: 3 })
      expect(snapshot.attempts[1]!.estimatedTokens).toHaveProperty('method', 'serialized-utf8-bytes/4')
      if (api === 'openai-responses') expect(received[1]).toHaveProperty('store', false)
      for await (const _event of provider.infer(
        { ...request, kind: 'summary', slot: 'compaction' },
        { signal: new AbortController().signal, toolNames: ['lookup'] },
      )) {
        /* drain */
      }
      expect((await store.get(request.sessionKey)).calls?.map((call) => call.kind)).toEqual([
        'inference',
        'compaction',
      ])
      cancel = true
      const controller = new AbortController()
      const pendingCancel = new Promise<void>((resolve) => {
        receivedCancel = resolve
      })
      const cancelledEvents = (async () => {
        const result = []
        for await (const event of provider.infer(request, {
          signal: controller.signal,
          toolNames: ['lookup'],
        }))
          result.push(event)
        return result
      })()
      await pendingCancel
      controller.abort()
      expect((await cancelledEvents).some((event) => event.type === 'done')).toBe(false)
      const last = (await store.get(request.sessionKey)).calls!.at(-1)!
      const cancelled = (await store.get(request.sessionKey, last.id)).snapshot!
      expect(cancelled.attempts).toHaveLength(1)
      expect(cancelled.attempts[0]).toMatchObject({ status: 'cancelled', providerActualTokens: null })
      expect(cancelled.response).toMatchObject({ status: 'error', reason: 'aborted' })
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000,
)

it('reports unavailable on an actual community WebSocket path instead of substituting its logical request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agh-trace-websocket-'))
  const sockets = new Set<import('node:stream').Duplex>()
  let upgrades = 0
  let httpCalls = 0
  const server = createServer((_req, res) => {
    httpCalls++
    res.writeHead(500)
    res.end()
  })
  server.on('upgrade', (req, socket) => {
    upgrades++
    sockets.add(socket)
    socket.on('error', () => undefined)
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    socket.once('data', () => {
      const events = reply('openai-responses')
        .split('\n\n')
        .filter(Boolean)
        .map((event) => JSON.parse(event.slice(event.indexOf('data: ') + 6)))
      for (const event of events) {
        const body = Buffer.from(JSON.stringify(event))
        const header =
          body.length < 126
            ? Buffer.from([0x81, body.length])
            : Buffer.from([0x81, 126, body.length >> 8, body.length & 255])
        socket.write(Buffer.concat([header, body]))
      }
    })
  })
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No local socket')
    const baseUrl = `http://127.0.0.1:${address.port}`
    class SocketAdapter extends FakeAdapter {
      override async *stream(
        _route: string,
        req: import('@agnes/protocol').RequestBody,
        _opts: import('@agnes/ai').AdapterStreamOptions,
      ): AsyncIterable<import('@agnes/ai').WireEvent> {
        const socket = new WebSocket(baseUrl.replace('http:', 'ws:'))
        try {
          const completed = new Promise<void>((resolve, reject) => {
            socket.addEventListener('message', (event) => {
              if (JSON.parse(String(event.data)).type === 'response.completed') resolve()
            })
            socket.addEventListener('error', reject)
          })
          await new Promise<void>((resolve, reject) => {
            socket.addEventListener('open', () => resolve())
            socket.addEventListener('error', reject)
          })
          socket.send(JSON.stringify({ instructions: req.system, input: req.messages }))
          await completed
          yield {
            type: 'usage',
            tokens: { input: 11, output: 3, cacheRead: 0, cacheWrite: 0 },
            creditSource: 'estimated',
          }
          yield { type: 'done', reason: 'stop' }
        } finally {
          socket.close()
        }
      }
    }
    const adapter = new SocketAdapter({
      id: 'socket',
      routes: [{ route: 'socket', api: 'community-ws', baseUrl, credentialRef: 'fixture' }],
      models: { socket: [fakeModel({ id: 'm', route: 'socket' })] },
    })
    const store = new RequestTraceStore(root, 'socket')
    const token = 'fixture-credential'
    const provider = createProvider({
      adapters: [adapter],
      routes: { primary: { route: 'socket', model: 'm' } },
      contract: new NullContractStore(),
      secrets: () => token,
      clock: Date.now,
      trace: store,
    })
    const request = fakeRequest({ route: 'socket', model: 'm', sessionKey: 'unique-socket-fixture' })
    const events = []
    for await (const event of provider.infer(request, {
      signal: new AbortController().signal,
      toolNames: [],
    }))
      events.push(event)
    expect(upgrades).toBe(1)
    expect(httpCalls).toBe(0)
    expect(events.at(-1)).toMatchObject({ type: 'done' })
    const call = (await store.get(request.sessionKey)).calls![0]!
    const snapshot = (await store.get(request.sessionKey, call.id)).snapshot!
    expect(snapshot).toMatchObject({
      capture: 'logical-request',
      wire: null,
      wireUnavailable: 'adapter-no-tap',
    })
    expect(snapshot.attempts[0]).toMatchObject({
      wire: null,
      wireUnavailable: 'adapter-no-tap',
      status: 'unknown',
    })
    expect(JSON.stringify(snapshot)).not.toContain(token)
  } finally {
    for (const socket of sockets) socket.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
