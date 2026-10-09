import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryPrivateEvent } from '@agnes/extension-api'
import { type EventEnvelope, normalizeRpcError, rpcError } from '@agnes/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { observabilityConfig } from '../src/config.js'
import { installDiagnosticJournal, readDiagnosticJournal } from '../src/journal.js'
import { createObservability } from '../src/provider.js'
import { OtlpTransport } from '../src/transport.js'
import { memoryCollector } from '../testkit/index.js'

afterEach(() => vi.unstubAllGlobals())

it('requires explicit opt-in and refuses invalid enabled settings without leaking configuration', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agh-observability-'))
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  try {
    const config = observabilityConfig(
      {},
      { AGH_HOME: home, OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' },
    )
    expect(config.enabled).toBe(false)
    const provider = createObservability(config)
    provider.bindSession('synthetic')()
    provider.lifecycle('daemon', 'start')
    provider.queueDepth(2)
    await provider.flush()
    await provider.dispose()
    expect(fetch).not.toHaveBeenCalled()
    for (const explicit of [
      { enabled: true },
      { enabled: true, endpoint: 'https://user:synthetic-password@example.invalid' },
      { enabled: true, endpoint: 'file:///synthetic' },
      { enabled: true, endpoint: 'http://localhost', timeoutMs: -1 },
      { enabled: true, endpoint: 'http://localhost', headers: { authorization: 'synthetic\r\nsecret' } },
    ])
      expect(() => observabilityConfig(explicit, { AGH_HOME: home })).toThrow()
    await writeFile(
      join(home, 'observability.json'),
      JSON.stringify({ enabled: true, endpoint: 'http://localhost:4318' }),
    )
    expect(observabilityConfig({}, { AGH_HOME: home }).enabled).toBe(true)
    expect(observabilityConfig({}, { AGH_HOME: home, OTEL_SDK_DISABLED: 'true' }).enabled).toBe(false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

it.each([false, true])(
  'exports accurate safe facts and lifecycle spans (memory privacy=%s)',
  async (memoryPrivate) => {
    const collector = await memoryCollector()
    const provider = createObservability({
      enabled: true,
      endpoint: collector.endpoint,
      includeContent: true,
    })
    const release = provider.bindSession('synthetic-session')
    let seq = 0
    const event = (type: EventEnvelope['type'], data: EventEnvelope['data']): void =>
      provider.observe(
        'synthetic-session',
        (memoryPrivate ? memoryPrivateEvent : (event: EventEnvelope) => event)({
          id: String(seq + 1),
          actor: { id: 'synthetic', org: 'synthetic', role: 'owner', deptPath: [], attrs: {} },
          origin: 'system',
          trust: 'trusted',
          seq: ++seq,
          ts: new Date().toISOString(),
          type,
          data,
        } as EventEnvelope),
      )
    try {
      event('turn/start', { turn: 1 })
      event('user/message', { content: { text: 'explicitly shared', authorization: 'synthetic-credential' } })
      event('request/header', { model: 'synthetic-model' })
      event('assistant/message', { content: 'explicitly shared response' })
      event('tool/call', { name: 'synthetic-tool', toolUseId: 'call' })
      event('tool/result', { toolUseId: 'call', isError: true, content: { apiKey: 'synthetic-key' } })
      event('cost/ledger', { tokens: { input: 3, output: 2 } })
      event('cost/ledger', { tokens: { input: 4, output: 1 } })
      event('turn/end', { reason: 'error' })
      event('turn/start', { turn: 2 })
      event('turn/end', { reason: 'aborted' })
      provider.lifecycle('daemon', 'start')
      provider.lifecycle('worker', 'start', undefined, 'worker')
      provider.lifecycle('worker', 'restart', undefined, 'worker')
      provider.queueDepth(2)
      release()
      await provider.dispose()
      const payload = JSON.stringify(collector.requests)
      if (memoryPrivate) expect(payload).not.toContain('explicitly shared')
      else expect(payload).toContain('explicitly shared')
      for (const secret of [
        'synthetic-credential',
        'synthetic-key',
        'synthetic-session',
        'synthetic-tool',
        'synthetic-model',
      ])
        expect(payload).not.toContain(secret)
      const spans = collector.requests
        .filter((r) => r.path === '/v1/traces')
        .flatMap((r) =>
          (
            r.body.resourceSpans as Array<{
              scopeSpans: Array<{ spans: Array<{ name: string; status: { code: number } }> }>
            }>
          ).flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans)),
        )
      expect(spans.find((row) => row.name === 'tool')?.status.code).toBe(2)
      expect(spans.filter((row) => row.name === 'turn').map((row) => row.status.code)).toEqual([2, 2])
      expect(spans.map((row) => row.name)).toEqual(
        expect.arrayContaining(['daemon', 'worker', 'worker.restart']),
      )
      const metrics = collector.requests
        .filter((r) => r.path === '/v1/metrics')
        .flatMap((r) =>
          (
            r.body.resourceMetrics as Array<{
              scopeMetrics: Array<{
                metrics: Array<{ name: string; sum?: { dataPoints: Array<{ asDouble: number }> } }>
              }>
            }>
          ).flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics)),
        )
      expect(metrics.map((row) => row.name)).toEqual(
        expect.arrayContaining([
          'agh.turn.duration',
          'agh.tool.duration',
          'agh.tool.calls',
          'agh.tool.errors',
          'agh.tokens.input',
          'agh.tokens.output',
          'agh.worker.restarts',
          'agh.queue.depth',
        ]),
      )
      expect(metrics.find((row) => row.name === 'agh.tokens.input')?.sum?.dataPoints[0]?.asDouble).toBe(7)
      expect(metrics.find((row) => row.name === 'agh.tokens.output')?.sum?.dataPoints[0]?.asDouble).toBe(3)
    } finally {
      await provider.dispose()
      await collector.close()
    }
  },
)

it('bounds delivery and accepts collector refusal without failing the caller', async () => {
  const fetch = vi.fn(async () => new Response('{}', { status: 400 }))
  vi.stubGlobal('fetch', fetch)
  const transport = new OtlpTransport({ enabled: true, endpoint: 'http://collector.invalid' })
  for (let i = 0; i < 1030; i++) transport.add('traces', { spanId: String(i) })
  await transport.dispose()
  expect(transport.dropped).toBeGreaterThan(0)
  expect(transport.failures).toBe(1)
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('persists diagnostic ids and projects untrusted history without messages or credentials', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agh-diagnostic-journal-'))
  const stop = installDiagnosticJournal(home)
  const retain = installDiagnosticJournal(home)
  try {
    stop()
    stop()
    const error = normalizeRpcError(rpcError('INTERNAL_ERROR', { detail: 'synthetic-private-secret' }))
    retain()
    const records = readDiagnosticJournal(home, 1, error.data!.diagnosticId)
    expect(records).toHaveLength(1)
    expect(records[0]?.diagnosticId).toBe(error.data!.diagnosticId)
    expect(JSON.stringify(records)).not.toContain('synthetic-private-secret')
    await writeFile(
      join(home, 'diagnostics', 'errors.jsonl'),
      JSON.stringify({
        ...records[0],
        diagnosticId: '11111111-1111-1111-1111-111111111111',
        message: 'synthetic-private-secret',
      }) + '\ninvalid\n',
    )
    const historical = readDiagnosticJournal(home, 1, '11111111-1111-1111-1111-111111111111')
    expect(historical).toHaveLength(1)
    expect(JSON.stringify(historical)).not.toContain('synthetic-private-secret')
    const recent = { ...historical[0], diagnosticId: '22222222-2222-2222-2222-222222222222' }
    await writeFile(
      join(home, 'diagnostics', 'errors.jsonl'),
      JSON.stringify(historical[0]) +
        '\n' +
        (' '.repeat(2049) + '\n').repeat(8) +
        JSON.stringify(recent) +
        '\n',
    )
    expect(readDiagnosticJournal(home, 1, historical[0]!.diagnosticId)).toEqual([])
    expect(readDiagnosticJournal(home, 1, recent.diagnosticId)).toEqual([recent])
  } finally {
    retain()
    stop()
    await rm(home, { recursive: true, force: true })
  }
})
