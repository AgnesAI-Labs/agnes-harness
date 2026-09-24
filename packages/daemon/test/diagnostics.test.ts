import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DiagnosticsCollectResult, DiagnosticsEventsResult, EventEnvelope } from '@agnes/protocol'
import { afterEach, describe, expect, it } from 'vitest'
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
const call = async <T>(ep: Endpoint, method: string, params: unknown): Promise<Response<T>> =>
  (await ep.handle({ jsonrpc: '2.0', id: id++, method, params })) as Response<T>

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup(options: { dataDir?: string } = {}, host: Parameters<typeof openTestHost>[0] = {}) {
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
      session.ev('user/message', { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] }),
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
      content: [{ type: 'image', data: '[OMITTED:image:base64]', mimeType: 'image/png' }],
    })
    expect(JSON.stringify(events)).not.toContain('AAAA')
    // The end is decided by lastSeq, not by row count: a full page that reaches lastSeq is the last.
    const last = await call<DiagnosticsEventsResult>(ep, '_agnes/v1/diagnostics.events', {
      sessionId,
      afterSeq: session.lastSeq - 1,
      limit: 1,
      maxBytes: 1024 * 1024,
    })
    expect(last.result?.events.map((event) => event.seq)).toEqual([session.lastSeq])
    expect(last.result?.nextAfterSeq).toBeNull()
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
