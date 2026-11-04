import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { UsageRow } from './types.js'
import { startUsageProxy, summarizeUsage } from './usage-proxy.js'

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }
type Upstream = { port: number; seen: Seen[]; close(): Promise<void> }

const startUpstream = async (
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<Upstream> => {
  const seen: Seen[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      handler(req, res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as AddressInfo).port,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

const rawGet = (
  port: number,
  path: string,
  headers: http.OutgoingHttpHeaders,
  onChunk?: (chunk: Buffer) => void,
): Promise<{ status: number; body: Buffer }> =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
        onChunk?.(chunk)
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end()
  })

const sse = (events: { event?: string; data: unknown }[]): string =>
  events
    .map(
      (e) =>
        `${e.event ? `event: ${e.event}\n` : ''}data: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}\n\n`,
    )
    .join('')

describe('usage proxy', () => {
  let dir: string
  let logFile: string
  let upstream: Upstream
  let proxy: { port: number; close(): Promise<void>; statuses(runId: string): number[] } | undefined

  const rows = (): UsageRow[] =>
    readFileSync(logFile, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as UsageRow)

  const errors = (): { runId: string; status: number; body: string }[] => {
    try {
      return readFileSync(join(dir, 'errors.jsonl'), 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line))
    } catch {
      return []
    }
  }

  const start = async (
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
    redact?: string[],
  ) => {
    upstream = await startUpstream(handler)
    proxy = await startUsageProxy({
      upstream: `http://127.0.0.1:${upstream.port}`,
      port: 0,
      logFile,
      ...(redact ? { redact } : {}),
    })
    return proxy
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rsi-usage-proxy-'))
    logFile = join(dir, 'usage.jsonl')
    proxy = undefined
  })

  afterEach(async () => {
    await proxy?.close()
    await upstream?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('records usage from a JSON response under its run id', async () => {
    const p = await start((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          type: 'message',
          model: 'claude-test',
          content: [],
          usage: {
            input_tokens: 11,
            output_tokens: 7,
            cache_read_input_tokens: 5,
            cache_creation_input_tokens: 3,
          },
        }),
      )
    })
    const response = await fetch(`http://127.0.0.1:${p.port}/run/run-a/v1/messages?beta=1`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test-123', 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    })
    expect(response.status).toBe(200)
    expect(((await response.json()) as { model: string }).model).toBe('claude-test')
    await p.close()
    // The prefix is stripped; path, query, method, body and auth headers pass through untouched.
    expect(upstream.seen).toHaveLength(1)
    expect(upstream.seen[0]).toMatchObject({
      method: 'POST',
      url: '/v1/messages?beta=1',
      body: '{"hello":"world"}',
    })
    expect(upstream.seen[0]?.headers.authorization).toBe('Bearer sk-test-123')
    const [row] = rows()
    expect(row).toMatchObject({
      runId: 'run-a',
      status: 200,
      model: 'claude-test',
      input: 11,
      output: 7,
      cacheRead: 5,
      cacheWrite: 3,
      usage: 'reported',
    })
    expect(Number.isNaN(Date.parse(row?.ts ?? ''))).toBe(false)
  })

  it('records usage from an Anthropic SSE stream', async () => {
    const p = await start((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(
        sse([
          {
            event: 'message_start',
            data: {
              type: 'message_start',
              message: {
                model: 'claude-sse',
                usage: {
                  input_tokens: 25,
                  output_tokens: 1,
                  cache_read_input_tokens: 100,
                  cache_creation_input_tokens: 40,
                },
              },
            },
          },
          { event: 'content_block_delta', data: { type: 'content_block_delta', delta: { text: 'hi' } } },
        ]),
      )
      res.end(
        sse([
          { event: 'message_delta', data: { type: 'message_delta', usage: { output_tokens: 42 } } },
          { event: 'message_stop', data: { type: 'message_stop' } },
        ]),
      )
    })
    await rawGet(p.port, '/run/run-b/v1/messages', {})
    await p.close()
    expect(rows()).toEqual([
      expect.objectContaining({
        runId: 'run-b',
        model: 'claude-sse',
        input: 25,
        output: 42,
        cacheRead: 100,
        cacheWrite: 40,
        usage: 'reported',
      }),
    ])
  })

  it('records usage from an OpenAI SSE stream with a final usage chunk', async () => {
    const p = await start((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(sse([{ data: { model: 'gpt-test', choices: [{ delta: { content: 'a' } }], usage: null } }]))
      res.write(
        sse([
          {
            data: {
              model: 'gpt-test',
              choices: [],
              usage: {
                prompt_tokens: 120,
                completion_tokens: 30,
                prompt_tokens_details: { cached_tokens: 80 },
              },
            },
          },
        ]),
      )
      res.end('data: [DONE]\n\n')
    })
    await rawGet(p.port, '/run/run-c/v1/chat/completions', {})
    await p.close()
    // OpenAI counts cached tokens inside prompt_tokens: input is the uncached remainder.
    expect(rows()).toEqual([
      expect.objectContaining({
        runId: 'run-c',
        model: 'gpt-test',
        input: 40,
        output: 30,
        cacheRead: 80,
        cacheWrite: 0,
        usage: 'reported',
      }),
    ])
  })

  it('records usage from an OpenAI JSON response without cache details', async () => {
    const p = await start((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ model: 'gpt-test', usage: { prompt_tokens: 9, completion_tokens: 4 } }))
    })
    await rawGet(p.port, '/run/run-d/v1/chat/completions', {})
    await p.close()
    expect(rows()[0]).toMatchObject({ input: 9, output: 4, cacheRead: 0, usage: 'reported' })
  })

  it('marks a response without usage as unknown, not zero', async () => {
    const p = await start((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [] }))
      } else if (req.url === '/v1/boom') {
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end('upstream exploded')
      } else {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(
          sse([
            {
              event: 'message_start',
              data: { type: 'message_start', message: { usage: { input_tokens: 5 } } },
            },
          ]),
        )
      }
    })
    await rawGet(p.port, '/run/run-e/v1/models', {})
    await rawGet(p.port, '/run/run-e/v1/boom', {})
    await rawGet(p.port, '/run/run-e/v1/truncated', {})
    await p.close()
    const logged = rows()
    expect(logged.map((row) => row.status)).toEqual([200, 500, 200])
    for (const row of logged) {
      expect(row).toMatchObject({
        runId: 'run-e',
        input: null,
        output: null,
        cacheRead: null,
        cacheWrite: null,
        usage: 'unknown',
      })
    }
  })

  it('never writes headers or bodies to the log', async () => {
    const p = await start((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'session=cookie-marker-789' })
      res.end(
        JSON.stringify({
          model: 'm',
          content: [{ text: 'response-body-marker-abc' }],
          usage: { input_tokens: 1, output_tokens: 2 },
        }),
      )
    })
    await fetch(`http://127.0.0.1:${p.port}/run/run-f/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-test-123',
        'x-api-key': 'k-test-456',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ prompt: 'request-body-marker-xyz' }),
    })
    await p.close()
    const raw = readFileSync(logFile, 'utf8')
    for (const secret of [
      'sk-test-123',
      'k-test-456',
      'request-body-marker-xyz',
      'response-body-marker-abc',
      'cookie-marker-789',
    ]) {
      expect(raw).not.toContain(secret)
    }
    expect(Object.keys(JSON.parse(raw.trim()) as object).sort()).toEqual(
      ['cacheRead', 'cacheWrite', 'input', 'model', 'output', 'runId', 'status', 'ts', 'usage'].sort(),
    )
  })

  it('streams the response through unchanged', async () => {
    let release: () => void = () => {}
    const clientGotFirst = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = sse([
      { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 3 } } } },
    ])
    const second = sse([
      { event: 'message_delta', data: { type: 'message_delta', usage: { output_tokens: 4 } } },
    ])
    const p = await start((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-upstream-marker': 'kept' })
      res.write(first)
      // The second chunk is only sent after the client saw the first: a buffering proxy would deadlock.
      void clientGotFirst.then(() => res.end(second))
    })
    const received: string[] = []
    const result = await Promise.race([
      rawGet(p.port, '/run/run-g/v1/messages', {}, (chunk) => {
        received.push(chunk.toString('utf8'))
        release()
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('response was buffered')), 3000)),
    ])
    expect(result.body.toString('utf8')).toBe(first + second)
    expect(received[0]).toBe(first)
    await p.close()
    expect(rows()[0]).toMatchObject({ input: 3, output: 4, usage: 'reported' })
  })

  it('forwards gzip bytes unchanged and still reads usage from them', async () => {
    const payload = gzipSync(
      Buffer.from(
        JSON.stringify({
          model: 'gz',
          usage: { input_tokens: 8, output_tokens: 2, cache_read_input_tokens: 1 },
        }),
      ),
    )
    const p = await start((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
      res.end(payload)
    })
    const result = await rawGet(p.port, '/run/run-h/v1/messages', { 'accept-encoding': 'gzip' })
    expect(result.body.equals(payload)).toBe(true)
    // The client's accept-encoding reaches the upstream untouched.
    expect(upstream.seen[0]?.headers['accept-encoding']).toBe('gzip')
    await p.close()
    expect(rows()[0]).toMatchObject({ model: 'gz', input: 8, output: 2, cacheRead: 1, usage: 'reported' })
  })

  it('answers 404 without calling upstream when the run prefix is missing', async () => {
    const p = await start((_req, res) => res.end('{}'))
    const result = await rawGet(p.port, '/v1/messages', {})
    expect(result.status).toBe(404)
    await p.close()
    expect(upstream.seen).toHaveLength(0)
  })

  it('answers 502 and logs an unknown row when the upstream is unreachable', async () => {
    upstream = await startUpstream((_req, res) => res.end('{}'))
    const deadPort = upstream.port
    await upstream.close()
    proxy = await startUsageProxy({ upstream: `http://127.0.0.1:${deadPort}`, port: 0, logFile })
    const result = await rawGet(proxy.port, '/run/run-i/v1/messages', {})
    expect(result.status).toBe(502)
    await proxy.close()
    expect(rows()).toEqual([
      expect.objectContaining({ runId: 'run-i', status: 502, usage: 'unknown', input: null }),
    ])
  })

  describe('responses that are not a 200', () => {
    const post = (port: number, runId: string) =>
      fetch(`http://127.0.0.1:${port}/run/${runId}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': 'k-test-456', 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'request-body-marker-xyz' }),
      })

    it('keeps the status in the usage log and a preview of the body in the error log', async () => {
      const p = await start((_req, res) => {
        res.writeHead(402, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Insufficient Balance', type: 'unknown_error' } }))
      })
      expect((await post(p.port, 'run-402')).status).toBe(402)
      await p.close()
      expect(rows()).toEqual([expect.objectContaining({ runId: 'run-402', status: 402, usage: 'unknown' })])
      expect(errors()).toEqual([
        {
          ts: expect.any(String),
          runId: 'run-402',
          status: 402,
          body: '{"error":{"message":"Insufficient Balance","type":"unknown_error"}}',
        },
      ])
      // The usage log itself still holds no body.
      expect(readFileSync(logFile, 'utf8')).not.toContain('Insufficient')
    })

    it('cuts a long body and removes the key, bearer tokens and header values', async () => {
      const key = 'sk-live-abcdef0123456789'
      const p = await start(
        (_req, res) => {
          res.writeHead(400, {
            'content-type': 'application/json',
            'set-cookie': 'session=cookie-marker-789',
          })
          res.end(
            JSON.stringify({
              error: {
                message: `bad request for ${key} Bearer tok-9988776655 ${'detail '.repeat(200)}`,
                authorization: 'Bearer abc',
              },
            }),
          )
        },
        [key],
      )
      await post(p.port, 'run-400')
      await p.close()
      const [row] = errors()
      expect(row?.status).toBe(400)
      expect(row?.body.length).toBeLessThanOrEqual(503)
      for (const secret of [
        key,
        'tok-9988776655',
        'k-test-456',
        'request-body-marker-xyz',
        'cookie-marker-789',
      ])
        expect(row?.body, secret).not.toContain(secret)
      expect(row?.body).toContain('bad request for')
    })

    it('reads a gzip body', async () => {
      const p = await start((_req, res) => {
        res.writeHead(429, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
        res.end(gzipSync(JSON.stringify({ error: { message: 'Rate limit reached' } })))
      })
      await post(p.port, 'run-429')
      await p.close()
      expect(errors()[0]?.body).toContain('Rate limit reached')
    })

    it('keeps nothing for a 200, and lists the statuses a run was answered with', async () => {
      let n = 0
      const p = await start((_req, res) => {
        res.writeHead(n++ < 2 ? 200 : 503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ model: 'm', usage: { input_tokens: 1, output_tokens: 2 } }))
      })
      for (let i = 0; i < 3; i++) await post(p.port, 'run-s')
      await post(p.port, 'other')
      await p.close()
      expect(p.statuses('run-s')).toEqual([200, 200, 503])
      expect(p.statuses('nobody')).toEqual([])
      expect(errors().map((e) => [e.runId, e.status])).toEqual([
        ['run-s', 503],
        ['other', 503],
      ])
    })

    it('says so when the upstream cannot be reached', async () => {
      upstream = await startUpstream((_req, res) => res.end('{}'))
      const deadPort = upstream.port
      await upstream.close()
      proxy = await startUsageProxy({ upstream: `http://127.0.0.1:${deadPort}`, port: 0, logFile })
      await rawGet(proxy.port, '/run/run-i/v1/messages', {})
      await proxy.close()
      expect(errors()).toEqual([
        expect.objectContaining({
          runId: 'run-i',
          status: 502,
          body: expect.stringContaining('unreachable'),
        }),
      ])
    })
  })
})

describe('summarizeUsage', () => {
  const row = (runId: string, patch: Partial<UsageRow>): UsageRow => ({
    ts: '2026-01-01T00:00:00.000Z',
    runId,
    status: 200,
    model: 'm',
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    usage: 'reported',
    ...patch,
  })

  it('summarizeUsage prices tokens per million and counts unknown rows', () => {
    const summary = summarizeUsage(
      [
        row('a', { input: 1_000_000, output: 500_000, cacheRead: 2_000_000, cacheWrite: 100_000 }),
        row('a', { input: 1_000_000, output: 0 }),
        row('a', {
          status: 500,
          input: null,
          output: null,
          cacheRead: null,
          cacheWrite: null,
          usage: 'unknown',
        }),
        row('b', { input: 10, output: 20 }),
      ],
      { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    )
    const a = summary.get('a')
    expect(a).toMatchObject({
      requests: 3,
      unknown: 1,
      tokens: { input: 2_000_000, output: 500_000, cacheRead: 2_000_000, cacheWrite: 100_000 },
    })
    // 2M*3 + 0.5M*15 + 2M*0.3 + 0.1M*3.75 = 6 + 7.5 + 0.6 + 0.375
    expect(a?.costUsd).toBeCloseTo(14.475, 9)
    expect(summary.get('b')).toMatchObject({ requests: 1, unknown: 0, tokens: { input: 10, output: 20 } })
    expect(summary.get('b')?.costUsd).toBeCloseTo((10 * 3 + 20 * 15) / 1e6, 12)
    expect([...summary.keys()]).toEqual(['a', 'b'])
  })
})
