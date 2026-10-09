import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EventEnvelope } from '@agnes/protocol'
import { expect, it, vi } from 'vitest'
import { createObservability } from '../src/provider.js'
import { acquireObservability } from '../src/runtime.js'
import { OtlpTransport } from '../src/transport.js'
import { memoryCollector } from '../testkit/index.js'

const event = (seq: number, type: string, data = {}): EventEnvelope =>
  ({ seq, type, data, ts: new Date().toISOString() }) as EventEnvelope
type WireRecord = { name?: string; spanId: string; parentSpanId?: string; traceId: string }
type WireScope = { spans?: WireRecord[]; logRecords?: WireRecord[] }
// Collector assertions inspect wire contracts, including OTLP log/span correlation.
const records = (collector: Awaited<ReturnType<typeof memoryCollector>>, signal: 'Spans' | 'Logs') =>
  collector.requests.flatMap((request) =>
    (
      (request.body[`resource${signal}`] as Array<{
        resource: unknown
        scopeSpans?: WireScope[]
        scopeLogs?: WireScope[]
      }>) ?? []
    ).flatMap((resource) =>
      (resource.scopeSpans ?? resource.scopeLogs ?? []).flatMap(
        (scope) => scope.spans ?? scope.logRecords ?? [],
      ),
    ),
  )

it('exports the session turn step model/tool tree and correlated metadata logs', async () => {
  const collector = await memoryCollector()
  const provider = createObservability({ enabled: true, endpoint: collector.endpoint })
  const release = provider.bindSession('session', {
    workspace: '/synthetic/workspace',
    generation: 'generation-2',
    pin: 'pin-2',
  })
  try {
    const events = [
      event(1, 'turn/start', { turn: 1 }),
      event(2, 'step/start', { turn: 1, step: 1 }),
      event(3, 'user/message', { content: 'private-prompt' }),
      event(4, 'request/header', { model: 'local' }),
      event(5, 'assistant/message', { content: 'private-output' }),
      event(6, 'tool/call', { name: 'test', toolUseId: 'call', args: { text: 'private-args' } }),
      event(7, 'tool/result', { toolUseId: 'call', content: 'private-result' }),
      event(8, 'step/end', { turn: 1, step: 1 }),
      event(9, 'turn/end', { reason: 'completed' }),
    ]
    for (const row of events) provider.observe('session', row)
    release()
    await provider.dispose()
    const spans = records(collector, 'Spans'),
      logs = records(collector, 'Logs')
    const span = (name: string) => spans.find((row) => row.name === name)!
    expect(span('turn').parentSpanId).toBe(span('session').spanId)
    expect(span('step').parentSpanId).toBe(span('turn').spanId)
    for (const name of ['model', 'tool']) expect(span(name).parentSpanId).toBe(span('step').spanId)
    expect(logs).toHaveLength(events.length)
    expect(logs.every((row) => row.traceId === span('session').traceId)).toBe(true)
    const wire = JSON.stringify(collector.requests)
    for (const secret of [
      'private-prompt',
      'private-output',
      'private-result',
      'private-args',
      '/synthetic/workspace',
    ])
      expect(wire).not.toContain(secret)
    expect(wire).toContain('generation-2')
    expect(wire).toContain('agh.pin.id')
  } finally {
    await provider.dispose()
    await collector.close()
  }
})

it('scrubs credential fields, referenced secrets and private roots even with content opt-in', async () => {
  const collector = await memoryCollector()
  vi.stubEnv('AGH_TEST_OTLP_SECRET', 'synthetic-header-secret')
  vi.stubEnv('AGH_TEST_PROVIDER_API_KEY', 'synthetic-provider-secret')
  const provider = createObservability({
    enabled: true,
    endpoint: collector.endpoint,
    redaction: 'content',
    headers: { authorization: { secretRef: 'env:AGH_TEST_OTLP_SECRET' } },
  })
  const release = provider.bindSession('s', {
    workspace: '/public/workspace',
    privateRoots: ['/private/state', 'C:\\private\\state'],
  })
  try {
    provider.observe(
      's',
      event(1, 'user/message', {
        content: {
          text: 'public text',
          password: 'hidden-password',
          echo: 'synthetic-header-secret',
          providerEcho: 'synthetic-provider-secret',
          prose: 'Bearer short-credential',
        },
      }),
    )
    provider.observe(
      's',
      event(2, 'tool/call', { name: 'test', toolUseId: 'safe', args: { text: 'public args' } }),
    )
    provider.observe('s', event(3, 'tool/result', { toolUseId: 'safe', content: 'public result' }))
    provider.child('s', 'child', 'start')
    const releaseChild = provider.bindSession('child')
    provider.observe(
      's',
      event(4, 'tool/call', {
        name: 'read',
        toolUseId: 'private',
        args: { path: 'C:\\PRIVATE\\state\\config' },
      }),
    )
    provider.observe('s', event(5, 'tool/result', { toolUseId: 'private', content: 'private-file-body' }))
    provider.observe('s', event(6, 'assistant/message', { content: 'echo private-file-body' }))
    provider.observe('child', event(1, 'user/message', { content: 'child echo private-file-body' }))
    provider.child('s', 'child', 'end')
    releaseChild()
    release()
    await provider.dispose()
    const wire = JSON.stringify(collector.requests)
    expect(wire).toContain('public text')
    expect(wire).toContain('public args')
    expect(wire).toContain('public result')
    for (const value of [
      'hidden-password',
      'synthetic-header-secret',
      'synthetic-provider-secret',
      'short-credential',
      '/private/state',
      'private-file-body',
    ])
      expect(wire).not.toContain(value)
  } finally {
    vi.unstubAllEnvs()
    await provider.dispose()
    await collector.close()
  }
})

it('bounds in-flight delivery, retains retryable failures and flushes after recovery', async () => {
  const collector = await memoryCollector()
  collector.refuse(503)
  const transport = new OtlpTransport({
    enabled: true,
    endpoint: collector.endpoint,
    queueSize: 2,
    batchSize: 1,
    batchMs: 30000,
  })
  try {
    transport.add('logs', { body: { stringValue: 'first' } })
    const pending = transport.flush()
    transport.add('logs', { body: { stringValue: 'second' } })
    transport.add('logs', { body: { stringValue: 'overflow' } })
    expect(transport.health()).toMatchObject({ queued: 2, dropped: 1 })
    await pending
    expect(transport.health()).toMatchObject({ status: 'backoff', queued: 2, dropped: 1 })
    collector.refuse(200)
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 200)
    await transport.dispose()
    vi.restoreAllMocks()
    expect(transport.health()).toMatchObject({ status: 'closed', queued: 0, dropped: 1 })
    expect(collector.requests.filter((row) => JSON.stringify(row.body).includes('second'))).toHaveLength(1)
  } finally {
    vi.restoreAllMocks()
    await transport.dispose()
    await collector.close()
  }
})

it('keeps a held batch and session watermark through a generation lease switch', async () => {
  const collector = await memoryCollector()
  const nextCollector = await memoryCollector()
  const home = await mkdtemp(join(tmpdir(), 'agh-otlp-upgrade-'))
  await writeFile(
    join(home, 'observability.json'),
    JSON.stringify({ enabled: true, endpoint: collector.endpoint, redaction: 'content' }),
  )
  let resume!: () => void
  collector.hold(
    new Promise<void>((resolve) => {
      resume = resolve
    }),
  )
  const old = acquireObservability(home)
  const oldRelease = old.bindSession('s', { generation: 'generation-1', privateRoots: ['/private/state'] })
  old.observe('s', event(1, 'turn/start', { turn: 1 }))
  old.observe('s', event(2, 'user/message', { content: 'old-approved-content' }))
  const pending = old.flush()
  const next = acquireObservability(home, { endpoint: nextCollector.endpoint, redaction: 'metadata' })
  const nextRelease = next.bindSession('s', { generation: 'generation-2' })
  try {
    await old.dispose()
    next.observe('s', event(2, 'user/message', { content: 'old-approved-content' }))
    next.observe('s', event(3, 'user/message', { content: 'new-private-content' }))
    next.observe('s', event(4, 'turn/end', { reason: 'completed' }))
    oldRelease()
    nextRelease()
    resume()
    await pending
    await next.dispose()
    expect(records(collector, 'Logs')).toHaveLength(2)
    expect(JSON.stringify(collector.requests)).toContain('old-approved-content')
    expect(records(nextCollector, 'Logs')).toHaveLength(2)
    expect(records(nextCollector, 'Spans').filter((row) => row.name === 'turn')).toHaveLength(1)
    const wire = JSON.stringify(nextCollector.requests)
    expect(wire).toContain('generation-1')
    for (const marker of ['old-approved-content', 'new-private-content', 'generation-2'])
      expect(wire).not.toContain(marker)
  } finally {
    resume()
    await old.dispose()
    await next.dispose()
    await collector.close()
    await nextCollector.close()
    await rm(home, { recursive: true, force: true })
  }
})

it('counts partial rejection and discards queued records under the shutdown discard policy', async () => {
  const collector = await memoryCollector()
  collector.partial({ rejectedLogRecords: '1' })
  const transport = new OtlpTransport({
    enabled: true,
    endpoint: collector.endpoint,
    shutdownPolicy: 'discard',
  })
  try {
    const resource = { 'agh.generation.id': 'captured-generation' }
    transport.add('logs', { body: { stringValue: 'one' } }, resource)
    resource['agh.generation.id'] = 'later-generation'
    await transport.flush()
    expect(JSON.stringify(collector.requests)).toContain('captured-generation')
    expect(JSON.stringify(collector.requests)).not.toContain('later-generation')
    expect(transport.health()).toMatchObject({ status: 'rejected', dropped: 1 })
    transport.add('logs', { body: { stringValue: 'two' } })
    await transport.dispose()
    expect(transport.dropped).toBe(2)
    expect(collector.requests).toHaveLength(1)
  } finally {
    await transport.dispose()
    await collector.close()
  }
})
