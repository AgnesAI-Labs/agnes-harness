import { inflateRawSync } from 'node:zlib'
import { type EventEnvelope, rpcError, type UITimeline } from '@agnes/protocol'
import { JsonRpcError } from '@agnes/sdk/browser'
import type { BrowserLog, DiagnosticsInclude } from '@agnes/web-units'
import { describe, expect, it } from 'vitest'
import {
  type CollectInput,
  collectDiagnostics,
  DIAGNOSTICS_LIMITS,
  diagnosticsFileName,
  type RpcCall,
} from '../src/diagnostics-bundle.js'

// Minimal reader: EOCD -> central directory -> local header -> (inflated) data, decoded as UTF-8.
function readZip(zip: Uint8Array): Map<string, string> {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  let eocd = zip.length - 22
  while (v.getUint32(eocd, true) !== 0x06054b50) eocd--
  const count = v.getUint16(eocd + 10, true)
  let p = v.getUint32(eocd + 16, true)
  const out = new Map<string, string>()
  for (let i = 0; i < count; i++) {
    const method = v.getUint16(p + 10, true)
    const csize = v.getUint32(p + 20, true)
    const nameLen = v.getUint16(p + 28, true)
    const extraLen = v.getUint16(p + 30, true)
    const commentLen = v.getUint16(p + 32, true)
    const local = v.getUint32(p + 42, true)
    const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen))
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true)
    const raw = zip.subarray(start, start + csize)
    out.set(name, new TextDecoder().decode(method === 8 ? inflateRawSync(raw) : raw))
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

const ALL: DiagnosticsInclude = { conversation: true, logs: true, system: true }
const NOW = new Date(Date.UTC(2026, 8, 24, 1, 2, 3))
const P = '_agnes/v1/'
// Fake credentials are concatenated so no literal token shape sits in this file for the secrets guard.
const SECRET_PROJECTION = 'sk-' + 'proj'.repeat(6)
const SECRET_EVENT = 'ghp_' + 'e'.repeat(36)
const SECRET_BROWSER = 'xoxb-' + 'b'.repeat(20)
const SECRET_CONFIG = 'AIza' + 'c'.repeat(30)
const SECRET_ERROR = 'sk-' + 'err'.repeat(8)
const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)

function ev(seq: number, type: string, data: unknown, extra: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    seq,
    ts: '2026-09-24T01:00:00.000Z',
    id: `ev-${seq}`,
    type,
    data,
    actor: { kind: 'system' },
    origin: 'system',
    trust: 'trusted',
    ...extra,
  } as EventEnvelope
}

const collectResult = {
  collectedAt: '2026-09-24T01:02:03.000Z',
  agh: { version: '9.9.9' },
  runtime: {
    platform: 'darwin',
    arch: 'arm64',
    osRelease: '25.0.0',
    node: '24.10.0',
    pid: 42,
    uptimeMs: 1000,
  },
  logs: [
    { name: 'daemon.jsonl', size: 10, text: '{"kind":"daemon"}\n', truncated: false, missing: false },
    { name: 'host.jsonl', size: 16, text: '{"kind":"host"}\n', truncated: false, missing: false },
  ],
}
const apisResult = {
  profile: { name: 'default', resolvedProfileHash: null, presets: { default: 'p', allowed: ['p'] } },
  families: [],
}

type Handler = (params: Record<string, unknown>) => unknown
const notFound = () => {
  throw new JsonRpcError(rpcError('METHOD_NOT_FOUND', { method: 'x' }))
}

function fake(handlers: Record<string, Handler>) {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const call: RpcCall = async (method, params) => {
    calls.push({ method, params: params as Record<string, unknown> })
    const handler = handlers[method.slice(P.length)]
    if (!handler) return notFound()
    return handler(params as Record<string, unknown>)
  }
  return { call, calls }
}

const ledger =
  (pages: EventEnvelope[][]): Handler =>
  ({ afterSeq }) => {
    const index = pages.findIndex((page) => (page[0]?.seq ?? 0) > (afterSeq as number))
    const page = pages[index] ?? []
    const last = pages.at(-1)?.at(-1)?.seq ?? 0
    const next = index === pages.length - 1 ? null : (page.at(-1)?.seq ?? null)
    return { events: page, lastSeq: last, nextAfterSeq: next }
  }

const browserLog: BrowserLog = { collectedAt: NOW.toISOString(), entries: [], dropped: 0, limit: 1000 }

function input(call: RpcCall, over: Partial<CollectInput> = {}): CollectInput {
  return {
    call,
    sessionId: 'abc-123_DEF456',
    sessionTitle: 'a title',
    projection: { sessionId: 'abc-123_DEF456', upto: 0, generation: 1, opState: null, nodes: [], turns: [] },
    browserLog,
    browser: { origin: 'http://127.0.0.1:4177' },
    now: NOW,
    ...over,
  }
}

const standard = (pages: EventEnvelope[][] = [[ev(1, 'user/message', { text: 'hi' })]]) => ({
  'diagnostics.collect': () => collectResult,
  'apis.list': () => apisResult,
  'config.get': () => ({ profile: 'default' }),
  'diagnostics.events': ledger(pages),
})

describe('diagnosticsFileName', () => {
  it('takes the first 8 alphanumerics after the last ":" and a UTC stamp', () => {
    const id = 'agnes:local:local-dev:cli:session:69270ffe-6369-4836-99f2-4b999006690c'
    expect(diagnosticsFileName(id, NOW)).toBe('agh-diagnostics-69270ffe-20260924-010203.zip')
  })

  it('falls back to the whole id when there is no ":"', () => {
    expect(diagnosticsFileName('abc-123_DEF456', NOW)).toBe('agh-diagnostics-abc123DE-20260924-010203.zip')
  })

  it('uses "application" for a null session id', () => {
    expect(diagnosticsFileName(null, NOW)).toBe('agh-diagnostics-application-20260924-010203.zip')
  })
})

describe('collectDiagnostics', () => {
  it('pages the ledger until nextAfterSeq is null', async () => {
    const pages = [
      [ev(1, 'user/message', {}), ev(2, 'turn/start', {})],
      [ev(3, 'user/message', {}), ev(4, 'turn/end', {})],
      [ev(5, 'user/message', {})],
    ]
    const { call, calls } = fake(standard(pages))
    const out = await collectDiagnostics(input(call), ALL, new AbortController().signal)
    const files = readZip(out.zip)
    expect(files.get('events.jsonl')?.trim().split('\n')).toHaveLength(5)
    expect(out.bundle.events).toEqual({ file: 'events.jsonl', count: 5, lastSeq: 5, truncated: false })
    const paged = calls.filter((c) => c.method === `${P}diagnostics.events`).map((c) => c.params)
    expect(paged.map((p) => p.afterSeq)).toEqual([0, 2, 4])
    for (const p of paged) {
      expect(p).toMatchObject({ sessionId: 'abc-123_DEF456', limit: 500, maxBytes: 1048576 })
    }
    expect(out.fileName).toBe('agh-diagnostics-abc123DE-20260924-010203.zip')
    // spec §5 write order
    expect([...files.keys()]).toEqual([
      'index.html',
      'system.json',
      'trace.json',
      'logs/daemon.jsonl',
      'logs/host.jsonl',
      'logs/browser.json',
      'events.jsonl',
    ])
    expect(out.bundle.version).toBe('9.9.9')
  })

  it('redacts every text file', async () => {
    const { call } = fake({
      ...standard([[ev(1, 'tool/result', { content: [{ type: 'text', text: `token ${SECRET_EVENT}` }] })]]),
      'config.get': () => ({ profile: 'default', provider: { note: `key ${SECRET_CONFIG}` } }),
    })
    const projection = {
      sessionId: 's',
      upto: 1,
      generation: 1,
      opState: null,
      nodes: [{ kind: 'context', id: 'n1', seq: 1, text: `leaked ${SECRET_PROJECTION}` }],
      turns: [],
    } as UITimeline
    const log: BrowserLog = {
      ...browserLog,
      entries: [{ ts: NOW.toISOString(), level: 'log', text: `slack ${SECRET_BROWSER}` }],
    }
    const out = await collectDiagnostics(
      input(call, { projection, browserLog: log }),
      ALL,
      new AbortController().signal,
    )
    const files = readZip(out.zip)
    expect(files.size).toBeGreaterThanOrEqual(6)
    for (const [name, text] of files) {
      for (const secret of [SECRET_PROJECTION, SECRET_EVENT, SECRET_BROWSER, SECRET_CONFIG]) {
        expect(text.includes(secret), `${name} leaks ${secret.slice(0, 4)}`).toBe(false)
      }
    }
    expect(files.get('events.jsonl')).toContain('REDACTED')
  })

  it('omits inline base64 media from trace.json and index.html without touching the live projection', async () => {
    const b64 = 'iVBORw0KGgo' + 'Q'.repeat(64)
    const image = { type: 'image', mimeType: 'image/png', data: b64 }
    const pdf = { type: 'document', source: { type: 'base64', data: b64 } }
    const projection = {
      sessionId: 's',
      upto: 1,
      generation: 1,
      opState: null,
      nodes: [{ kind: 'user', id: 'n1', seq: 1, actorLabel: 'u', content: [image, pdf] }],
      turns: [],
    } as unknown as UITimeline
    const { call } = fake(standard())
    const out = await collectDiagnostics(input(call, { projection }), ALL, new AbortController().signal)
    const files = readZip(out.zip)
    for (const name of ['trace.json', 'index.html']) {
      expect(files.get(name)).toContain('[OMITTED:image:base64]')
      expect(files.get(name)).toContain('[OMITTED:binary:base64]')
      expect(files.get(name)).not.toContain(b64)
    }
    expect(image.data).toBe(b64)
  })

  it('degrades METHOD_NOT_FOUND to unavailable and keeps packaging', async () => {
    const { call } = fake({
      'apis.list': () => {
        throw new Error(`boom ${SECRET_ERROR}`)
      },
      'config.get': () => {
        throw new JsonRpcError(rpcError('METHOD_NOT_FOUND', { code: 'NOT_REGISTERED' }))
      },
    })
    const out = await collectDiagnostics(input(call), ALL, new AbortController().signal)
    const files = readZip(out.zip)
    for (const name of ['index.html', 'trace.json', 'logs/browser.json', 'system.json']) {
      expect(files.has(name), name).toBe(true)
    }
    expect(files.has('events.jsonl')).toBe(false)
    expect(out.bundle.warnings).toEqual(
      expect.arrayContaining([
        { source: 'diagnostics.collect', reason: 'unavailable' },
        { source: 'config.get', reason: 'unavailable' },
        { source: 'diagnostics.events', reason: 'unavailable' },
        expect.objectContaining({ source: 'apis.list', reason: 'failed' }),
      ]),
    )
    const failed = out.bundle.warnings.find((w) => w.source === 'apis.list')
    expect(failed?.detail).toContain('boom')
    expect(failed?.detail).not.toContain(SECRET_ERROR)
    expect(JSON.parse(files.get('diagnostic-export-warnings.json') ?? '[]')).toEqual(out.bundle.warnings)
    expect(out.bundle.version).toBe('unknown')
  })

  it('treats SESSION_NOT_FOUND on the ledger as unavailable', async () => {
    const { call } = fake({
      ...standard(),
      'diagnostics.events': () => {
        throw new JsonRpcError(rpcError('SESSION_NOT_FOUND'))
      },
    })
    const out = await collectDiagnostics(input(call), ALL, new AbortController().signal)
    expect(out.bundle.warnings).toEqual([{ source: 'diagnostics.events', reason: 'unavailable' }])
  })

  it('truncates ledger over ledgerBytes', async () => {
    const big = (seq: number) => ev(seq, 'user/message', { text: 'x'.repeat(100) })
    const { call } = fake(
      standard([
        [big(1), big(2)],
        [big(3), big(4)],
      ]),
    )
    const out = await collectDiagnostics(input(call), ALL, new AbortController().signal, {
      ledgerBytes: 600,
    })
    expect(out.bundle.events?.truncated).toBe(true)
    expect(out.bundle.events?.count).toBeLessThan(4)
    expect(out.bundle.events?.count).toBeGreaterThan(0)
    expect(out.bundle.warnings).toContainEqual({ source: 'diagnostics.events', reason: 'truncated' })
    const lines = readZip(out.zip).get('events.jsonl')?.trim().split('\n') ?? []
    expect(lines).toHaveLength(out.bundle.events?.count ?? -1)
  })

  it('include toggles files', async () => {
    const { call, calls } = fake(standard())
    const out = await collectDiagnostics(
      input(call),
      { conversation: false, logs: true, system: false },
      new AbortController().signal,
    )
    const files = readZip(out.zip)
    for (const name of ['trace.json', 'events.jsonl', 'system.json'])
      expect(files.has(name), name).toBe(false)
    expect(files.has('logs/browser.json')).toBe(true)
    expect(files.has('logs/daemon.jsonl')).toBe(true)
    expect(calls.some((c) => c.method === `${P}diagnostics.events`)).toBe(false)
    expect(out.bundle.trace).toBeUndefined()
    expect(out.bundle.system).toBeUndefined()
  })

  it('no session: no ledger, no trace, application file name', async () => {
    const { call, calls } = fake(standard())
    const out = await collectDiagnostics(
      input(call, { sessionId: null, sessionTitle: null, projection: undefined }),
      ALL,
      new AbortController().signal,
    )
    expect(calls.some((c) => c.method === `${P}diagnostics.events`)).toBe(false)
    expect(readZip(out.zip).has('trace.json')).toBe(false)
    expect(out.fileName).toBe('agh-diagnostics-application-20260924-010203.zip')
    expect(out.bundle.include.conversation).toBe(false)
  })

  it('extracts artifact metadata deduplicated by (lane, sha256)', async () => {
    const media = {
      media: { manifest: [{ sha256: SHA_A, mime: 'image/png', artifactUri: `artifact://${SHA_A}` }] },
    }
    const toolResult = {
      toolUseId: 't1',
      content: [
        { type: 'resource_link', uri: `artifact://${SHA_B}`, mimeType: 'image/jpeg', name: 'artifact' },
      ],
      isError: false,
    }
    const { call } = fake(
      standard([
        [
          ev(1, 'request/header', media),
          ev(2, 'tool/result', toolResult, { origin: 'tool:computer_use', trust: 'untrusted' }),
          ev(3, 'request/header', media),
        ],
      ]),
    )
    const out = await collectDiagnostics(input(call), ALL, new AbortController().signal)
    expect(out.bundle.artifacts).toEqual([
      {
        sha256: SHA_A,
        mime: 'image/png',
        lane: 'main',
        seq: 1,
        source: 'request-media',
        uri: `artifact://${SHA_A}`,
      },
      {
        sha256: SHA_B,
        mime: 'image/jpeg',
        lane: 'main',
        seq: 2,
        source: 'tool-result',
        uri: `artifact://${SHA_B}`,
      },
    ])
  })

  it('rejects with AbortError when the user aborts mid-ledger', async () => {
    const controller = new AbortController()
    const { call } = fake({
      ...standard(),
      'diagnostics.events': ({ afterSeq }) => {
        if (afterSeq === 0) return { events: [ev(1, 'user/message', {})], lastSeq: 9, nextAfterSeq: 1 }
        controller.abort()
        return new Promise(() => {})
      },
    })
    await expect(collectDiagnostics(input(call), ALL, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  it('times out a hung RPC and still packages', async () => {
    const call: RpcCall = () => new Promise(() => {})
    const out = await collectDiagnostics(input(call), ALL, new AbortController().signal, { rpcMs: 20 })
    expect(out.bundle.warnings).toEqual(
      expect.arrayContaining([
        { source: 'diagnostics.collect', reason: 'timeout' },
        { source: 'diagnostics.events', reason: 'timeout' },
      ]),
    )
    expect(readZip(out.zip).has('index.html')).toBe(true)
  })

  it('packages what it has when the total budget runs out', async () => {
    const call: RpcCall = () => new Promise(() => {})
    const out = await collectDiagnostics(input(call), ALL, new AbortController().signal, { totalMs: 30 })
    expect(out.bundle.warnings).toContainEqual({ source: 'collect', reason: 'timeout' })
    expect(readZip(out.zip).has('trace.json')).toBe(true)
  })

  it('keeps paging across an all-chunk page with no events', async () => {
    const { call, calls } = fake({
      ...standard(),
      'diagnostics.events': ({ afterSeq }) =>
        afterSeq === 0
          ? { events: [ev(1, 'user/message', {})], lastSeq: 6, nextAfterSeq: 1 }
          : afterSeq === 1
            ? { events: [], lastSeq: 6, nextAfterSeq: 5 }
            : { events: [ev(6, 'turn/end', {})], lastSeq: 6, nextAfterSeq: null },
    })
    const out = await collectDiagnostics(input(call), ALL, new AbortController().signal)
    const paged = calls.filter((c) => c.method === `${P}diagnostics.events`).map((c) => c.params.afterSeq)
    expect(paged).toEqual([0, 1, 5])
    expect(out.bundle.events).toEqual({ file: 'events.jsonl', count: 2, lastSeq: 6, truncated: false })
  })

  it('stops as truncated when the cursor does not advance', async () => {
    const { call, calls } = fake({
      ...standard(),
      'diagnostics.events': ({ afterSeq }) =>
        afterSeq === 0
          ? { events: [ev(1, 'user/message', {}), ev(2, 'turn/end', {})], lastSeq: 9, nextAfterSeq: 2 }
          : { events: [], lastSeq: 9, nextAfterSeq: 2 },
    })
    const out = await collectDiagnostics(input(call), ALL, new AbortController().signal)
    expect(calls.filter((c) => c.method === `${P}diagnostics.events`)).toHaveLength(2)
    expect(out.bundle.events).toMatchObject({ count: 2, truncated: true })
    expect(out.bundle.warnings).toContainEqual({ source: 'diagnostics.events', reason: 'truncated' })
  })

  it('keeps earlier pages when a later ledger page fails', async () => {
    const { call } = fake({
      ...standard(),
      'diagnostics.events': ({ afterSeq }) => {
        if (afterSeq === 0) return { events: [ev(1, 'user/message', {})], lastSeq: 9, nextAfterSeq: 1 }
        throw new Error('scan failed')
      },
    })
    const out = await collectDiagnostics(input(call), ALL, new AbortController().signal)
    expect(out.bundle.events).toEqual({ file: 'events.jsonl', count: 1, lastSeq: 1, truncated: true })
    expect(readZip(out.zip).get('events.jsonl')?.trim().split('\n')).toHaveLength(1)
    expect(out.bundle.warnings).toContainEqual(
      expect.objectContaining({ source: 'diagnostics.events', reason: 'failed' }),
    )
  })

  it('keeps missing logs in the bundle and warns', async () => {
    const missing = { size: 0, text: '', truncated: false, missing: true }
    const { call } = fake({
      ...standard(),
      'diagnostics.collect': () => ({
        ...collectResult,
        logs: [
          { name: 'daemon.jsonl', ...missing },
          { name: 'host.jsonl', ...missing },
        ],
      }),
    })
    const out = await collectDiagnostics(input(call), ALL, new AbortController().signal)
    expect(out.bundle.logs?.daemon?.missing).toBe(true)
    expect(out.bundle.logs?.host?.missing).toBe(true)
    expect(out.bundle.warnings).toContainEqual(
      expect.objectContaining({ source: 'logs', reason: 'unavailable' }),
    )
    const files = readZip(out.zip)
    expect(files.has('logs/daemon.jsonl')).toBe(false)
    expect(files.has('logs/browser.json')).toBe(true)
  })

  it('does not warn about diagnostics.collect when neither logs nor system is selected', async () => {
    const { call, calls } = fake({ 'diagnostics.events': ledger([[ev(1, 'user/message', {})]]) })
    const out = await collectDiagnostics(
      input(call),
      { conversation: true, logs: false, system: false },
      new AbortController().signal,
    )
    expect(calls.some((c) => c.method === `${P}diagnostics.collect`)).toBe(true)
    expect(out.bundle.warnings).toEqual([])
  })

  it('classifies a stray AbortError from the transport as failed, not a user abort', async () => {
    const { call } = fake({
      ...standard(),
      'config.get': () => {
        throw new DOMException('socket reset', 'AbortError')
      },
    })
    const out = await collectDiagnostics(input(call), ALL, new AbortController().signal)
    expect(out.bundle.warnings).toContainEqual(
      expect.objectContaining({ source: 'config.get', reason: 'failed' }),
    )
  })

  it('skips entries past the zip byte cap with a limit warning', async () => {
    const { call } = fake(standard())
    const out = await collectDiagnostics(input(call), ALL, new AbortController().signal, { zipBytes: 10 })
    const files = readZip(out.zip)
    expect([...files.keys()]).toEqual(['index.html', 'diagnostic-export-warnings.json'])
    expect(out.bundle.warnings).toEqual(
      expect.arrayContaining([
        { source: 'system.json', reason: 'limit' },
        { source: 'events.jsonl', reason: 'limit' },
      ]),
    )
    expect(DIAGNOSTICS_LIMITS.zipBytes).toBe(64 * 1024 * 1024)
  })
})
