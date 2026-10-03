import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RuntimeMethodSchemaRefs, RuntimeSchemaRefs } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { createFileAudit } from '../../src/audit.js'
import { inline } from '../../src/runtime/trace/provider-support.js'
import { billingInput, exportInput, traceInput } from './billing-trace-fixture.js'
import { billingTraceProcessDriver } from './billing-trace-process.js'

describe.each(['default', 'reference'] as const)('consent and mandatory audit %s', (kind) => {
  it.each(['DISABLED', 'LOCAL', 'ANON', 'FULL'] as const)(
    '%s follows fixed consent, current revocation and managed egress',
    async (level) => {
      const driver = billingTraceProcessDriver('trace', kind, { level })
      try {
        await driver.start()
        const original = traceInput.spans[0]
        if (!original) throw new Error('trace fixture span absent')
        const input = {
          ...traceInput,
          spans: [
            ...traceInput.spans,
            { ...original, spanId: 'synthetic-child', parentSpanId: original.spanId, outcome: 'cancelled' },
            { ...original, spanId: 'synthetic-unknown', parentSpanId: null, outcome: 'unknown' },
          ],
        }
        const request = {
          ...exportInput(level),
          body: inline(RuntimeMethodSchemaRefs['agh.trace'].record.input, input),
        }
        await driver.record(input)
        const result = (await driver.export(request)) as { outcome: string }
        if (level === 'DISABLED' || level === 'LOCAL') {
          expect(result.outcome).toBe('failed')
          expect(await driver.deliveries()).toBe(0)
        } else {
          expect(result.outcome).toBe('succeeded')
          expect(await driver.deliveries()).toBe(1)
          const sent = JSON.stringify(driver.records())
          expect(sent.includes('private business content')).toBe(level === 'FULL')
          expect(sent.includes('alice@example.test')).toBe(level === 'FULL')
          const received = driver.records()[0]
          if (!received) throw new Error('OTLP body absent')
          const packet = received.body as {
            resourceSpans: {
              scopeSpans: { spans: { spanId: string; parentSpanId?: string; status: { code: number } }[] }[]
            }[]
          }
          const spans = packet.resourceSpans[0]?.scopeSpans[0]?.spans
          const parent = spans?.[0],
            child = spans?.[1]
          if (!parent || !child) throw new Error('OTLP spans absent')
          expect(child.parentSpanId).toBe(level === 'FULL' ? parent.spanId : undefined)
          expect(spans?.map((span) => span.status.code)).toEqual([1, 2, 0])
        }
        await driver.invoke('revoke')
        const blocked = (await driver.export({
          ...request,
          batchId: 'revoked',
          body: { ...request.body },
        })) as { outcome: string; error?: { code: string } }
        expect(blocked.error?.code).toBe('denied')
        await driver.restart()
        const restored = (await driver.export(request)) as { outcome: string; error?: { code: string } }
        expect(restored.outcome).toBe('failed')
        expect(restored.error?.code).toBe('denied')
        expect(await driver.deliveries()).toBe(level === 'ANON' || level === 'FULL' ? 1 : 0)
      } finally {
        await driver.close()
      }
    },
    30000,
  )
  it('exports an approved trajectory projection through the same managed consent gate', async () => {
    const driver = billingTraceProcessDriver('trace', kind, { path: '/trajectory' })
    try {
      await driver.start()
      const request = {
        ...exportInput(),
        kind: 'trajectory',
        body: inline(RuntimeSchemaRefs.StandardToolOutput, {
          content: [{ type: 'text', text: 'private trajectory alice@example.test' }],
        }),
      }
      const result = (await driver.export(request)) as { outcome: string }
      expect(result.outcome).toBe('succeeded')
      expect(await driver.deliveries()).toBe(1)
      expect(JSON.stringify(driver.records())).not.toContain('private trajectory')
      await driver.invoke('revoke')
      expect(((await driver.export(request)) as { error?: { code: string } }).error?.code).toBe('denied')
      expect(await driver.deliveries()).toBe(1)
    } finally {
      await driver.close()
    }
  }, 30000)
  it.each(['DISABLED', 'LOCAL', 'ANON'] as const)(
    'keeps business and mandatory file audit when Trace is %s or fails',
    async (level) => {
      const trace = billingTraceProcessDriver('trace', kind, { level, path: '/disconnect' }),
        billing = billingTraceProcessDriver('billing', kind)
      let audit: ReturnType<typeof createFileAudit> | undefined
      try {
        await trace.start()
        await billing.start()
        const file = join(trace.directory, 'mandatory.jsonl')
        audit = createFileAudit(file)
        audit.write({ kind: 'host.ready', detail: { trace: level } })
        const traceResult = (await trace.export(exportInput(level))) as { outcome: string }
        expect(traceResult.outcome).toBe(level === 'ANON' ? 'unknown_effect' : 'failed')
        const posted = (await billing.post(billingInput)) as { outcome: string }
        expect(posted.outcome).toBe('succeeded')
        audit.write({ kind: 'host.closed', detail: { billing: 'posted' } })
        await audit.close?.()
        expect(readFileSync(file, 'utf8')).toContain('host.closed')
        expect(await trace.deliveries()).toBe(level === 'ANON' ? 1 : 0)
        expect(await billing.deliveries()).toBe(1)
      } finally {
        await audit?.close?.()
        await trace.close()
        await billing.close()
      }
    },
    30000,
  )
})
