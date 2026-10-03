import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { readEmbeddingVectors } from '../../src/runtime/embedding/data.js'
import { createEmbeddingConsumer, embeddingInput, embeddingScope } from './embedding-fixture.js'

const kinds = ['default', 'reference'] as const
for (const kind of kinds)
  describe(`${kind} embedding`, () => {
    it('returns ordered vectors and original usage refs for repeated deliveries; changed fingerprints conflict', async () => {
      const directory = mkdtempSync(join(tmpdir(), 'embedding-normal-'))
      const c = await createEmbeddingConsumer({ directory, kind, allowOtherPrincipal: true })
      try {
        expect(validateRuntime('ProviderDescriptor', c.descriptor).ok).toBe(true)
        for (const forged of [
          { bindingId: 'other-binding' },
          { runId: 'other-run' },
          { inputDigest: '0'.repeat(64) },
        ]) {
          expect(((await c.encode(embeddingInput, undefined, forged)) as W.EffectResult).error?.code).toBe(
            'invalid_input',
          )
        }
        expect(c.deliveries()).toBe(0)
        const first = (await c.encode()) as W.EffectResult
        expect(first.outcome).toBe('succeeded')
        expect(await c.encode()).toEqual(first)
        expect(((await c.encode(embeddingInput, 'other-principal')) as W.EffectResult).error?.code).toBe(
          'conflict',
        )
        expect(((await c.encode({ ...embeddingInput, dimensions: 3 })) as W.EffectResult).error?.code).toBe(
          'conflict',
        )
        expect(c.deliveries()).toBe(1)
        expect(c.usages()).toHaveLength(1)
        const usage = c.usages()[0]?.request
        if (!usage) throw Error('Missing fixture usage')
        expect(usage.attemptRef.actionId).toBe('synthetic-action')
        expect(usage.attemptRef.attemptId).toBe('synthetic-attempt')
        expect(usage.externalReceiptRef).toEqual(usage.measurement.sourceReceipt)
        expect(usage.measurement.quantities).toEqual([{ unit: 'synthetic-request', value: '1' }])
        expect(c.effects.calls().map((x) => x.operation)).toEqual(['agh.network.request'])
        if (first.result?.kind !== 'inline') throw Error('missing result')
        const parsed = validateRuntime('EmbeddingEncodeResult', first.result.value)
        expect(parsed.ok).toBe(true)
        if (!parsed.ok) throw Error('invalid result')
        expect(parsed.value.vectorsRef.schema).toEqual(RuntimeSchemaRefs.EmbeddingVectors)
        expect(parsed.value.inputDigest).toBe(canonicalJsonDigest(embeddingInput))
        expect(parsed.value.usageRefs).toEqual(c.usages()[0]?.result.factRefs)
        const fact = c.usages()[0]?.fact
        if (!fact) throw Error('Missing persisted Usage fact')
        expect(validateRuntime('UsageFact', fact).ok).toBe(true)
        expect(parsed.value.usageRefs[0]?.digest).toBe(canonicalJsonDigest(fact))
        expect(fact).toMatchObject({
          actionId: 'synthetic-action',
          attemptId: 'synthetic-attempt',
          certainty: 'measured',
        })

        const call = {
          scope: embeddingScope,
          principalRef: 'synthetic-principal',
          authorizationRef: 'synthetic-auth',
          bindingId: 'synthetic-embedding-binding',
          invocationId: 'vector-consumer',
          traceRef: 'synthetic-trace',
          deadline: '2030-01-01T00:00:00Z',
          signal: new AbortController().signal,
        }
        expect(await readEmbeddingVectors(parsed.value.vectorsRef, embeddingInput, call, c.blobRead)).toEqual(
          {
            ok: true,
            value: [
              [1, 0],
              [0, 1],
            ],
          },
        )
        c.revoke()
        expect(((await c.encode()) as W.EffectResult).error?.code).toBe('denied')
      } finally {
        await c.close()
        rmSync(directory, { recursive: true, force: true })
      }
    })
    it.each([
      { label: 'missing row', matrix: [[1, 0]] },
      {
        label: 'extra row',
        matrix: [
          [1, 0],
          [0, 1],
          [1, 0],
        ],
      },
      { label: 'wrong dimensions', matrix: [[1], [1]] },
      {
        label: 'non-number',
        matrix: [
          [null, 0],
          [0, 1],
        ],
      },
      {
        label: 'zero norm',
        matrix: [
          [0, 0],
          [0, 1],
        ],
      },
      {
        label: 'non-unit norm',
        matrix: [
          [2, 0],
          [0, 1],
        ],
      },
    ])('rejects $label without discarding occurred usage', async ({ matrix }) => {
      const directory = mkdtempSync(join(tmpdir(), 'embedding-invalid-')),
        c = await createEmbeddingConsumer({ directory, kind, matrix })
      try {
        const result = (await c.encode()) as W.EffectResult
        expect(result.outcome).toBe('failed')
        expect(result.result).toBeUndefined()
        expect(result.error?.detailCode).toBe('embedding_vectors')
        expect(validateRuntime('DataRef', result.error?.safeDetail).ok).toBe(true)
        expect(c.usages()).toHaveLength(1)
        expect(await c.encode()).toEqual(result)
        expect(c.deliveries()).toBe(1)
      } finally {
        await c.close()
        rmSync(directory, { recursive: true, force: true })
      }
    })
    it.each([
      { production: true, detail: 'model_gateway_unavailable' },
      { noUsage: true, detail: 'usage_port_unavailable' },
      {
        input: { ...embeddingInput, modelRoute: { ...embeddingInput.modelRoute, model: 'live-embedding' } },
        detail: 'model_gateway_unavailable',
      },
    ])('refuses missing production dependencies: $detail', async (options) => {
      const directory = mkdtempSync(join(tmpdir(), 'embedding-unavailable-')),
        c = await createEmbeddingConsumer({ directory, kind, ...options })
      try {
        expect(((await c.encode()) as W.EffectResult).error?.detailCode).toBe(options.detail)
        expect(c.deliveries()).toBe(0)
        expect(c.usages()).toHaveLength(0)
      } finally {
        await c.close()
        rmSync(directory, { recursive: true, force: true })
      }
    })
    it('handles empty inputs and unnormalized vectors; refuses dimensions outside the contract before dispatch', async () => {
      for (const [input, matrix] of [
        [{ ...embeddingInput, inputRefs: [] }, []],
        [
          { ...embeddingInput, normalize: false },
          [
            [3, 4],
            [-5, 12],
          ],
        ],
        [
          { ...embeddingInput, dimensions: 0 },
          [
            [1, 0],
            [0, 1],
          ],
        ],
        [
          { ...embeddingInput, dimensions: 10001 },
          [
            [1, 0],
            [0, 1],
          ],
        ],
      ] as const) {
        const directory = mkdtempSync(join(tmpdir(), 'embedding-boundary-'))
        const c = await createEmbeddingConsumer({
          directory,
          kind,
          input: structuredClone(input) as W.EmbeddingEncodeRequest,
          matrix,
        })
        try {
          const reply = (await c.encode(structuredClone(input) as W.EmbeddingEncodeRequest)) as W.EffectResult
          expect(reply.outcome).toBe(
            input.dimensions === 0 || input.dimensions === 10001 ? 'failed' : 'succeeded',
          )
          if (reply.outcome === 'failed') {
            expect(c.deliveries()).toBe(0)
            expect(c.usages()).toHaveLength(0)
          }
        } finally {
          await c.close()
          rmSync(directory, { recursive: true, force: true })
        }
      }
    })
    it('persists a known receipt when usage is unavailable and resumes without another delivery', async () => {
      const directory = mkdtempSync(join(tmpdir(), 'embedding-usage-'))
      const first = await createEmbeddingConsumer({ directory, kind, usageFail: true })
      try {
        expect(((await first.encode()) as W.EffectResult).error?.detailCode).toBe('usage_unconfirmed')
        expect(first.deliveries()).toBe(1)
        expect(first.usages()).toHaveLength(0)
        await first.close()
        const second = await createEmbeddingConsumer({ directory, kind })
        try {
          expect(((await second.encode()) as W.EffectResult).outcome).toBe('succeeded')
          expect(second.deliveries()).toBe(1)
          expect(second.usages()).toHaveLength(1)
        } finally {
          await second.close()
        }
      } finally {
        await first.close()
        rmSync(directory, { recursive: true, force: true })
      }
    })
  })
describe('embedding implementation independence', () => {
  it('keeps reference independent and below the nonblank line-set overlap limit', () => {
    const defaultFiles = ['providers/embedding.ts', 'embedding/data.ts', 'embedding/journal.ts']
    const lines = (text: string) =>
      new Set(
        text
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
      )
    const a = lines(
      defaultFiles
        .map((path) => readFileSync(new URL(`../../src/runtime/${path}`, import.meta.url), 'utf8'))
        .join('\n'),
    )
    const source = readFileSync(
      new URL('../../../../examples/runtime-reference/src/providers/embedding.ts', import.meta.url),
      'utf8',
    )
    expect(source).not.toMatch(/(?:packages\/ai|@agnes\/ai|runtime\/embedding)/u)
    const b = lines(source),
      common = [...a].filter((line) => b.has(line)).length
    expect(common / Math.min(a.size, b.size)).toBeLessThanOrEqual(0.5)
  })
})
