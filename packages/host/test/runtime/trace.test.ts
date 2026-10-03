import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inspectReferenceTrace } from '../../../../examples/runtime-reference/src/providers/trace.js'
import { createBillingTraceNetworkFixture } from '../../../extension-api/testkit/runtime/contracts/billing.js'
import { openTraceQueue } from '../../src/runtime/trace/export-queue.js'
import { billingInput, createBillingTraceConsumer, exportInput, traceInput } from './billing-trace-fixture.js'

describe.each(['default', 'reference'] as const)('local trace %s', (kind) => {
  it('records locally, rejects conflicting batches and preserves disabled consent', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'trace-local-'))
    const consumer = await createBillingTraceConsumer({
      createEffects: createBillingTraceNetworkFixture,
      directory,
      kind,
      service: 'trace',
      port: 9,
      capacity: 2,
    })
    try {
      const first = await consumer.record(traceInput)
      expect(first?.ok).toBe(true)
      expect(await consumer.record(traceInput)).toEqual(first)
      const changed = await consumer.record({ ...traceInput, spans: [] })
      expect(changed?.ok).toBe(false)
      if (changed && !changed.ok) expect(changed.error.code).toBe('conflict')
      const second = await consumer.record({
        ...traceInput,
        batchId: 'second',
        spans: [...traceInput.spans, ...traceInput.spans],
      })
      expect(second?.ok && second.value.kind === 'inline' && second.value.value).toEqual({
        accepted: 1,
        dropped: 1,
      })
      const full = await consumer.record({ ...traceInput, batchId: 'overflow' })
      expect(full?.ok).toBe(false)
      consumer.changeConsent('FULL')
      const upgrade = await consumer.record({ ...traceInput, batchId: 'upgrade' })
      expect(upgrade?.ok).toBe(false)
      if (upgrade && !upgrade.ok) expect(upgrade.error.code).toBe('conflict')
    } finally {
      await consumer.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('DISABLED drops optional spans while no network is attempted', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'trace-disabled-')),
      consumer = await createBillingTraceConsumer({
        createEffects: createBillingTraceNetworkFixture,
        directory,
        kind,
        service: 'trace',
        port: 9,
        level: 'DISABLED',
      })
    try {
      const result = await consumer.record(traceInput)
      expect(result?.ok && result.value.kind === 'inline' && result.value.value).toEqual({
        accepted: 0,
        dropped: 1,
      })
    } finally {
      await consumer.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
it('persists drop totals, cursor and replay boundaries across queue reopen', () => {
  const directory = mkdtempSync(join(tmpdir(), 'trace-cursor-')),
    path = join(directory, 'trace.sqlite')
  let queue = openTraceQueue(path, 2)
  try {
    queue.record(
      'owner',
      { ...traceInput, spans: [...traceInput.spans, ...traceInput.spans, ...traceInput.spans] },
      false,
    )
    expect(queue.stats('owner')).toEqual({ accepted: 2, dropped: 1, cursor: 1, replayFrom: 0 })
    queue.close()
    queue = openTraceQueue(path, 2)
    expect(queue.page('owner', 0, 2)).toHaveLength(1)
    expect(queue.page('owner', 1, 2)).toHaveLength(0)
    expect(queue.stats('owner').dropped).toBe(1)
    expect(() => queue.page('owner', -1, 1)).toThrow()
  } finally {
    queue.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it.each(['billing', 'trace'] as const)(
  '%s returns the same public result and refusal code across independent providers',
  async (service) => {
    const directory = mkdtempSync(join(tmpdir(), 'billing-trace-cross-'))
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(Buffer.from(c))
      const value = JSON.parse(Buffer.concat(chunks).toString())
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(service === 'trace' ? {} : { ...value, status: 'posted' }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const outputs: unknown[] = [],
      refusals: unknown[] = []
    try {
      for (const kind of ['default', 'reference'] as const) {
        const root = join(directory, kind),
          consumer = await createBillingTraceConsumer({
            createEffects: createBillingTraceNetworkFixture,
            directory: root,
            kind,
            service,
            port,
            capacity: 2,
          })
        try {
          if (service === 'trace') {
            expect((await consumer.record(traceInput))?.ok).toBe(true)
            const more = await consumer.record({
              ...traceInput,
              batchId: 'second',
              spans: [...traceInput.spans, ...traceInput.spans],
            })
            expect(more?.ok && more.value.kind === 'inline' && more.value.value).toEqual({
              accepted: 1,
              dropped: 1,
            })
            const stats =
              kind === 'default'
                ? (() => {
                    const queue = openTraceQueue(join(root, 'trace.sqlite'), 2)
                    try {
                      return queue.stats('synthetic-session')
                    } finally {
                      queue.close()
                    }
                  })()
                : inspectReferenceTrace(join(root, 'trace.sqlite'), 'synthetic-session').stats
            expect(stats).toEqual({ accepted: 2, dropped: 1, cursor: 2, replayFrom: 0 })
          }
          outputs.push(
            await consumer.action(
              service === 'trace' ? 'export' : 'post',
              service === 'trace' ? exportInput() : billingInput,
            ),
          )
          if (service === 'trace') {
            const chain =
              kind === 'default'
                ? (() => {
                    const queue = openTraceQueue(join(root, 'trace.sqlite'), 2)
                    try {
                      return queue.chain('synthetic-session')
                    } finally {
                      queue.close()
                    }
                  })()
                : inspectReferenceTrace(join(root, 'trace.sqlite'), 'synthetic-session').chains[
                    'synthetic-session'
                  ]
            expect(chain).toMatchObject({
              consent: 'ANON',
              prev: null,
              bytes: expect.any(Number),
              sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
              chain: expect.stringMatching(/^[0-9a-f]{64}$/),
              networkReceipt: expect.any(Object),
            })
          }
          const deny = await consumer.action(
            service === 'trace' ? 'export' : 'post',
            service === 'trace' ? exportInput() : billingInput,
            'deny',
          )
          refusals.push({ outcome: deny.outcome, code: deny.error?.code, detail: deny.error?.detailCode })
        } finally {
          await consumer.close()
        }
      }
      expect(outputs[0]).toEqual(outputs[1])
      expect(refusals[0]).toEqual(refusals[1])
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(directory, { recursive: true, force: true })
    }
  },
)
