import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { localPackageAdminAuthority, localWebSkinReadAuthority, denyPackageAdminAuthority } from '@agnes/daemon-admin/packages/index'
import { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { installDiagnosticJournal } from '@agnes/observability'
import {
  type ApisListResult,
  type DiagnosticsCollectResult,
  type DiagnosticsEventsResult,
  type DiagnosticsExportResult,
  type EventEnvelope,
  normalizeRpcError,
  rpcError,
} from '@agnes/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { registerDiagnostics } from '../src/local/methods/diagnostics.js'
import { openTestHost } from './host.js'

const initialize = {
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  },
}

type Endpoint = ReturnType<Awaited<ReturnType<typeof openTestHost>>['endpoint']>
type Response<T> = { result?: T; error?: { data?: { code?: string } } }

let id = 10
const call = async <T>(ep: Pick<Endpoint, 'handle'>, method: string, params: unknown): Promise<Response<T>> =>
  (await ep.handle({ jsonrpc: '2.0', id: id++, method, params })) as Response<T>

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup(
  options: { dataDir?: string; diagnosticsHome?: string } = {},
  host: Parameters<typeof openTestHost>[0] = {},
) {
  const h = await openTestHost(host)
  const ep = h.endpoint({ pollMs: 5, ...options })
  cleanups.push(() => h.close())
  cleanups.push(() => ep.close())
  await ep.handle(initialize)
  return { h, ep }
}

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-diagnostics-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'audit'), { recursive: true })
  return dir
}

async function newSession(ep: Endpoint, cwd: string): Promise<string> {
  const created = await call<{ sessionId: string }>(ep, 'session/new', { cwd, mcpServers: [] })
  if (!created.result) throw new Error(`session/new failed: ${JSON.stringify(created)}`)
  return created.result.sessionId
}

async function readAll(ep: Endpoint, sessionId: string, limit: number, maxBytes: number) {
  const pages: DiagnosticsEventsResult[] = []
  let afterSeq = 0
  for (let guard = 0; guard < 100; guard++) {
    const page = await call<DiagnosticsEventsResult>(ep, '_agnes/v1/diagnostics.events', {
      sessionId,
      afterSeq,
      limit,
      maxBytes,
    })
    if (!page.result) throw new Error(`diagnostics.events failed: ${JSON.stringify(page)}`)
    pages.push(page.result)
    if (page.result.nextAfterSeq === null) return pages
    expect(page.result.nextAfterSeq).toBeGreaterThan(afterSeq)
    afterSeq = page.result.nextAfterSeq
  }
  throw new Error('diagnostics.events never reached the end')
}

describe('diagnostics.export', () => {
  it('exports an owned historical snapshot without opening a live session', async () => {
    const home = tempDataDir()
    const ep = new LocalEndpoint({ clock: Date.now, principalId: 'synthetic-owner' })
    cleanups.push(() => ep.close())
    ep.conn.initialized = true
    ep.conn.authKind = 'local'
    ep.conn.credentialKind = 'local'
    let authority = localPackageAdminAuthority()
    let readOnly = false
    registerDiagnostics(ep, {
      authority: (context) => authority(context),
      readOnly: async () => readOnly,
      home,
      telemetry: { enabled: false, includeContent: false, endpointHosts: ['collector.example:4318'] },
      registry: {
        get: () => undefined,
        require: () => {
          throw new Error('must not open live session')
        },
      },
      requireSessionOwner: (_method, key) => {
        if (key !== 'historical') throw rpcError('CAPABILITY_DENIED')
      },
      sessionSnapshot: (key) =>
        key === 'historical' ? { lastSeq: 23, loop: { id: 'synthetic-loop', version: '1.0.0' } } : undefined,
    })
    const exported = await call<DiagnosticsExportResult>(ep, '_agnes/v1/diagnostics.export', {
      sessionId: 'historical',
    })
    expect(exported.result?.session).toMatchObject({
      lastSeq: 23,
      idHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      loopIdHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(exported.result?.telemetry).toEqual({
      enabled: false,
      includeContent: false,
      endpointHosts: ['collector.example:4318'],
    })
    expect(JSON.stringify(exported.result)).not.toContain('synthetic-loop')
    const denied = await call(ep, '_agnes/v1/diagnostics.export', { sessionId: 'foreign' })
    expect(denied.error?.data?.code).toBe('CAPABILITY_DENIED')
    expect((await call(ep, '_agnes/v1/admin.observability', {})).result).toMatchObject({
      settings: { enabled: false },
      health: { status: 'disabled' },
    })
    for (const deniedAuthority of [denyPackageAdminAuthority, localWebSkinReadAuthority]) {
      authority = deniedAuthority
      for (const params of [{}, { settings: { enabled: false } }, { test: true }])
        expect(await call(ep, '_agnes/v1/admin.observability', params)).toHaveProperty('error.data.code', 'CAPABILITY_DENIED')
    }
    authority = localPackageAdminAuthority(['packages.read'])
    expect((await call(ep, '_agnes/v1/admin.observability', {})).result).toBeDefined()
    for (const params of [{ settings: { enabled: false } }, { test: true }])
      expect(await call(ep, '_agnes/v1/admin.observability', params)).toHaveProperty('error.data.code', 'CAPABILITY_DENIED')
    authority = localPackageAdminAuthority()
    readOnly = true
    expect((await call(ep, '_agnes/v1/admin.observability', {})).result).toBeDefined()
    for (const params of [{ settings: { enabled: false } }, { test: true }])
      expect(await call(ep, '_agnes/v1/admin.observability', params)).toHaveProperty('error.data.reason', 'E_ADMIN_READ_ONLY')
    expect(() => statSync(join(home, 'observability.json'))).toThrow()
    ep.conn.authKind = 'jwt'
    expect(await call(ep, '_agnes/v1/admin.observability', {})).toHaveProperty(
      'error.data.code',
      'CAPABILITY_DENIED',
    )
  })

  it('exports only metadata and locates transport and durable diagnostic IDs without secrets', async () => {
    const home = tempDataDir()
    const stop = installDiagnosticJournal(home)
    const secret = ['synthetic', 'private-body-and-path'].join('-')
    const old = normalizeRpcError(rpcError('INTERNAL_ERROR', { message: secret, password: secret }))
    stop()
    writeFileSync(
      join(home, 'audit', 'daemon.jsonl'),
      JSON.stringify({
        at: '2026-10-08T00:00:00.000Z',
        kind: 'daemon.request_failed',
        detail: { diagnosticId: old.data.diagnosticId, message: secret, argv: secret },
        prompt: secret,
      }) + '\n',
    )
    const { h, ep } = await setup({ dataDir: home, diagnosticsHome: home })
    const id = await newSession(ep, h.dataDir)
    const invalid = (await call<{ never: true }>(ep, '_agnes/v1/diagnostics.export', {
      limit: 999,
      password: secret,
    })) as { error: { data: { diagnosticId: string } } }
    const bundle = await call<DiagnosticsExportResult>(ep, '_agnes/v1/diagnostics.export', {
      sessionId: id,
      limit: 1,
    })
    expect(bundle.error).toBeUndefined()
    const apis = await call<ApisListResult>(ep, '_agnes/v1/apis.list', {})
    expect(apis.result?.families.find((row) => row.name === 'diagnostics')?.methods).toContain(
      '_agnes/v1/diagnostics.export',
    )
    expect(bundle.result?.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ diagnosticId: old.data.diagnosticId }),
        expect.objectContaining({ diagnosticId: invalid.error.data.diagnosticId }),
      ]),
    )
    expect(bundle.result?.session?.idHash).toMatch(/^[a-f0-9]{64}$/)
    expect(bundle.result?.profile.hash).toBe(h.host.profile.hash)
    expect(bundle.result?.audit).toEqual([
      { at: '2026-10-08T00:00:00.000Z', kind: 'daemon.request_failed', diagnosticId: old.data.diagnosticId },
    ])
    const text = JSON.stringify(bundle.result)
    for (const value of [secret, home, h.dataDir, id]) expect(text).not.toContain(value)
    const exact = await call<DiagnosticsExportResult>(ep, '_agnes/v1/diagnostics.export', {
      diagnosticId: old.data.diagnosticId,
    })
    expect(exact.result?.errors).toHaveLength(1)
    expect(exact.result?.errors[0]?.diagnosticId).toBe(old.data.diagnosticId)
    ep.conn.authKind = 'jwt'
    expect(await call(ep, '_agnes/v1/diagnostics.export', {})).toHaveProperty(
      'error.data.code',
      'CAPABILITY_DENIED',
    )
  })
})

describe('diagnostics.collect', () => {
  it('collect rejects non-local owner', async () => {
    const { ep } = await setup({ dataDir: tempDataDir() })
    ep.conn.authKind = 'jwt'
    expect(await call(ep, '_agnes/v1/diagnostics.collect', {})).toHaveProperty(
      'error.data.code',
      'CAPABILITY_DENIED',
    )
    ep.conn.authKind = 'local'
    ep.conn.credentialKind = 'jwt'
    expect(await call(ep, '_agnes/v1/diagnostics.collect', {})).toHaveProperty(
      'error.data.code',
      'CAPABILITY_DENIED',
    )
  })

  it('collect reads whole-line tails and marks missing files', async () => {
    const dataDir = tempDataDir()
    const file = join(dataDir, 'audit', 'daemon.jsonl')
    const pad = 'x'.repeat(200)
    const lines = Array.from(
      { length: 8_000 },
      (_, n) =>
        `${JSON.stringify({ at: '2026-09-24T00:00:00.000Z', kind: 'daemon.request', detail: { n, pad } })}\n`,
    )
    writeFileSync(file, lines.join(''))
    expect(statSync(file).size).toBeGreaterThan(1024 * 1024)
    const { ep } = await setup({ dataDir })
    const r = await call<DiagnosticsCollectResult>(ep, '_agnes/v1/diagnostics.collect', {})
    const daemon = r.result?.logs.find((log) => log.name === 'daemon.jsonl')
    const host = r.result?.logs.find((log) => log.name === 'host.jsonl')
    expect(daemon).toMatchObject({ truncated: true, missing: false, size: statSync(file).size })
    const kept = daemon?.text.split('\n').filter(Boolean) ?? []
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThan(lines.length)
    // The first kept line is whole: it parses, and it is exactly one of the lines written.
    const first = JSON.parse(kept[0] ?? '') as { kind: string; detail: { n: number } }
    expect(first.kind).toBe('daemon.request')
    // The tail ends at the last line written.
    expect((JSON.parse(kept.at(-1) ?? '') as { detail: { n: number } }).detail.n).toBe(lines.length - 1)
    expect(Buffer.byteLength(daemon?.text ?? '')).toBeLessThanOrEqual(1024 * 1024)
    expect(host).toEqual({ name: 'host.jsonl', size: 0, text: '', truncated: false, missing: true })
  })

  it('collect re-redacts detail', async () => {
    const dataDir = tempDataDir()
    const secretName = 'api' + 'Key'
    writeFileSync(
      join(dataDir, 'audit', 'host.jsonl'),
      [
        JSON.stringify({
          at: '2026-09-24T00:00:00.000Z',
          kind: 'extension.service-call',
          detail: { [secretName]: 'abc' },
        }),
        '{not json',
        '',
      ].join('\n'),
    )
    const { ep } = await setup({ dataDir })
    const r = await call<DiagnosticsCollectResult>(ep, '_agnes/v1/diagnostics.collect', {})
    const host = r.result?.logs.find((log) => log.name === 'host.jsonl')
    expect(host).toMatchObject({ truncated: false, missing: false })
    const rows = (host?.text.split('\n').filter(Boolean) ?? []).map((line) => JSON.parse(line))
    expect(rows).toEqual([
      {
        at: '2026-09-24T00:00:00.000Z',
        kind: 'extension.service-call',
        detail: { [secretName]: '<redacted>' },
      },
      { at: null, kind: 'unparseable' },
    ])
    expect(host?.text).not.toContain('abc')
  })

  it('collect without dataDir marks both logs missing', async () => {
    const { ep } = await setup()
    const r = await call<DiagnosticsCollectResult>(ep, '_agnes/v1/diagnostics.collect', {})
    expect(r.result?.logs).toEqual([
      { name: 'daemon.jsonl', size: 0, text: '', truncated: false, missing: true },
      { name: 'host.jsonl', size: 0, text: '', truncated: false, missing: true },
    ])
  })

  it('collect reports runtime and version', async () => {
    const { ep } = await setup()
    const r = await call<DiagnosticsCollectResult>(ep, '_agnes/v1/diagnostics.collect', {})
    expect(r.result?.agh.version).toBe('dev')
    expect(r.result?.runtime).toMatchObject({ pid: process.pid, node: process.versions.node })
    expect(r.result?.runtime.uptimeMs).toBeGreaterThanOrEqual(0)
    expect(Number.isNaN(Date.parse(r.result?.collectedAt ?? ''))).toBe(false)
  })
})

describe('diagnostics.events', () => {
  it('events rejects non-owner', async () => {
    const { h, ep } = await setup()
    const sessionId = await newSession(ep, h.dataDir)
    // Same local authentication, different principal: only the session-owner check can refuse it.
    const stranger = h.endpoint({
      pollMs: 5,
      identity: { principalId: 'other-principal', authKind: 'local', credentialKind: 'local' },
    })
    cleanups.push(() => stranger.close())
    await stranger.handle(initialize)
    expect(stranger.conn.authKind).toBe('local')
    expect(
      await call(stranger, '_agnes/v1/diagnostics.events', {
        sessionId,
        afterSeq: 0,
        limit: 10,
        maxBytes: 65536,
      }),
    ).toHaveProperty('error.data.code', 'CAPABILITY_DENIED')
  })

  it('events pages to the end, carries every row, sanitizes base64', async () => {
    // A real turn: its streamed text is never a row, only the output start marker is.
    const twoChunks = [
      { type: 'text_delta' as const, delta: 'a' },
      { type: 'text_delta' as const, delta: 'b' },
      { type: 'done' as const, reason: 'stop' as const },
    ]
    const { h, ep } = await setup({}, { script: [twoChunks] })
    const sessionId = await newSession(ep, h.dataDir)
    const session = h.host.kernel.get(sessionId)
    if (!session) throw new Error('session not open')
    const text = (t: string) => ({ content: [{ type: 'text', text: t }] })
    expect(
      await call(ep, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'one' }] }),
    ).toHaveProperty('result')
    await session.append([
      session.ev('user/message', text('two')),
      session.ev('user/message', text('three')),
      session.ev('user/message', {
        content: [
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          { type: 'file', name: 'private.txt', mimeType: 'text/plain', data: 'cHJpdmF0ZSBjb250ZW50' },
        ],
      }),
    ])
    const ledger = (await session.scan({ fromSeq: 1, limit: 500 })) as readonly EventEnvelope[]
    expect(ledger.filter((row) => row.type === 'assistant/output')).toHaveLength(1)
    expect(ledger.filter((row) => row.type === 'user/message')).toHaveLength(4)
    const expected = ledger.map((row) => row.seq)

    const pages = await readAll(ep, sessionId, 2, 1024 * 1024)
    expect(pages.length).toBeGreaterThan(1)
    for (const page of pages) expect(page.lastSeq).toBe(session.lastSeq)
    const events = pages.flatMap((page) => page.events)
    const seqs = events.map((event) => event.seq)
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1] ?? 0)
    expect(seqs).toEqual(expected)
    expect(events.some((event) => event.type === 'assistant/output')).toBe(true)
    const image = events.at(-1)
    expect(image?.data).toEqual({
      content: [
        { type: 'image', data: '[OMITTED:image:base64]', mimeType: 'image/png' },
        { type: 'file', name: 'private.txt', mimeType: 'text/plain', data: '[OMITTED:file:base64]' },
      ],
    })
    expect(JSON.stringify(events)).not.toContain('AAAA')
    expect(JSON.stringify(events)).not.toContain('cHJpdmF0ZSBjb250ZW50')
    // The end is decided by lastSeq, not by row count: a full page that reaches lastSeq is the last.
    const last = await call<DiagnosticsEventsResult>(ep, '_agnes/v1/diagnostics.events', {
      sessionId,
      afterSeq: session.lastSeq - 1,
      limit: 1,
      maxBytes: 1024 * 1024,
    })
    expect(last.result?.events.map((event) => event.seq)).toEqual([session.lastSeq])
    expect(last.result?.nextAfterSeq).toBeNull()
    await session.append([
      session.ev('x/core/memory-private', { files: 1 }, { ignorable: true }),
      session.ev('user/message', text('MEMORY_PRIVATE_PREFERENCE_ECHO')),
    ])
    const privatePages = await readAll(ep, sessionId, 2, 1024 * 1024)
    const privateEvents = privatePages.flatMap((page) => page.events)
    expect(privateEvents.map((event) => event.seq)).toEqual(
      (await session.scan({ fromSeq: 1, limit: 500 })).map((row) => row.seq),
    )
    for (const event of privateEvents) expect(event.data).toMatchObject({ memoryContentOmitted: true })
    expect(JSON.stringify(privateEvents)).not.toContain('MEMORY_PRIVATE_PREFERENCE_ECHO')
    expect(privateEvents.find((event) => event.type === 'user/message')?.data).not.toHaveProperty('content')
  })

  it('events maxBytes cuts pages by bytes, at least one row', async () => {
    const { h, ep } = await setup()
    const sessionId = await newSession(ep, h.dataDir)
    const session = h.host.kernel.get(sessionId)
    if (!session) throw new Error('session not open')
    await session.append([
      session.ev('user/message', { content: [{ type: 'text', text: 'before' }] }),
      session.ev('user/message', { content: [{ type: 'text', text: '中'.repeat(2000) }] }),
      session.ev('user/message', { content: [{ type: 'text', text: 'after' }] }),
    ])
    const pages = await readAll(ep, sessionId, 500, 1024)
    // Without the byte budget one 500-row page would hold the whole small ledger.
    expect(pages.length).toBeGreaterThan(1)
    for (const page of pages) expect(page.events.length).toBeGreaterThanOrEqual(1)
    const big = pages.find((page) =>
      page.events.some((event) => JSON.stringify(event).includes('中'.repeat(2000))),
    )
    expect(big?.events).toHaveLength(1)
    expect(
      pages
        .flatMap((page) => page.events)
        .map((event) => event.seq)
        .at(-1),
    ).toBe(session.lastSeq)
  })

  it('events unknown session', async () => {
    const { ep } = await setup()
    expect(
      await call(ep, '_agnes/v1/diagnostics.events', {
        sessionId: 'agnes:missing',
        afterSeq: 0,
        limit: 10,
        maxBytes: 65536,
      }),
    ).toHaveProperty('error.data.code', 'SESSION_NOT_FOUND')
  })
})
