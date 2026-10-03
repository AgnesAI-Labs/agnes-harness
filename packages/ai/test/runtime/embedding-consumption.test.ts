import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { embeddingRef, readEmbeddingVectors } from '../../src/runtime/embedding/data.js'
import { createEmbeddingConsumer, embeddingInput, embeddingScope } from './embedding-fixture.js'

const call = {
  scope: embeddingScope,
  principalRef: 'synthetic-principal',
  authorizationRef: 'synthetic-auth',
  bindingId: 'synthetic-embedding-binding',
  invocationId: 'consumer',
  traceRef: 'synthetic-trace',
  deadline: '2030-01-01T00:00:00Z',
  signal: new AbortController().signal,
}
describe('embedding result consumption', () => {
  it.each(['default', 'reference'] as const)(
    'validates %s result before publishing vectors, including persisted blob tampering',
    async (kind) => {
      const directory = mkdtempSync(join(tmpdir(), 'embedding-consumer-')),
        consumer = await createEmbeddingConsumer({ directory, kind })
      const published: W.EmbeddingVectors[] = []
      async function consume(effect: W.EffectResult) {
        if (effect.outcome !== 'succeeded' || effect.result?.kind !== 'inline') return false
        const output = validateRuntime('EmbeddingEncodeResult', effect.result.value)
        if (
          !output.ok ||
          output.value.inputDigest !== canonicalJsonDigest(embeddingInput) ||
          output.value.dimensions !== embeddingInput.dimensions
        )
          return false
        const vectors = await readEmbeddingVectors(
          output.value.vectorsRef,
          embeddingInput,
          call,
          consumer.blobRead,
        )
        if (!vectors.ok) return false
        published.push(vectors.value)
        return true
      }
      try {
        const effect = (await consumer.encode()) as W.EffectResult
        expect(await consume(effect)).toBe(true)
        if (effect.result?.kind !== 'inline') throw Error('missing embedding')
        const output = validateRuntime('EmbeddingEncodeResult', effect.result.value)
        if (!output.ok || output.value.vectorsRef.kind !== 'blob') throw Error('missing blob')
        const file = join(directory, 'content', output.value.vectorsRef.blob.blobId)
        const original = readFileSync(file)
        writeFileSync(file, Buffer.from('[[1],[1]]'))
        expect(await consume(effect)).toBe(false)
        expect(((await consumer.encode()) as W.EffectResult).error?.detailCode).toBe('embedding_vectors')
        expect(published).toEqual([
          [
            [1, 0],
            [0, 1],
          ],
        ])
        expect(consumer.deliveries()).toBe(1)
        expect(consumer.usages()).toHaveLength(1)
        writeFileSync(file, original)
        expect(await consumer.encode()).toEqual(effect)
      } finally {
        await consumer.close()
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )
  it.each(
    [
      [
        [NaN, 0],
        [0, 1],
      ],
      [
        [Infinity, 0],
        [0, 1],
      ],
      [
        [-Infinity, 0],
        [0, 1],
      ],
      [Object.assign(new Array<number>(2), { 1: 0 }), [0, 1]],
      [
        ['1', 0],
        [0, 1],
      ],
      [[1, 0]],
      [[1], [1]],
    ].map((matrix) => ({ matrix })),
  )('rejects malformed inline content before publication (%#)', async ({ matrix }) => {
    const ref: W.DataRef = {
      kind: 'inline',
      value: matrix as W.JsonValue,
      schema: RuntimeSchemaRefs.EmbeddingVectors,
      bytes: 1,
      digest: '0'.repeat(64),
    }
    expect((await readEmbeddingVectors(ref, embeddingInput, call)).ok).toBe(false)
  })
  it('rejects forged schema, bytes and digest while accepting canonical negative zero', async () => {
    const matrix = [
        [1, -0],
        [0, 1],
      ],
      valid = embeddingRef(RuntimeSchemaRefs.EmbeddingVectors, matrix)
    expect((await readEmbeddingVectors(valid, embeddingInput, call)).ok).toBe(true)
    if (valid.kind !== 'inline') throw Error('inline fixture')
    for (const ref of [
      { ...valid, schema: { ...valid.schema, digest: '0'.repeat(64) } },
      { ...valid, bytes: valid.bytes + 1 },
      { ...valid, digest: '0'.repeat(64) },
    ])
      expect((await readEmbeddingVectors(ref, embeddingInput, call)).ok).toBe(false)
    // This blob has a genuine byte proof; its JSON exponent overflows IEEE finite numbers.
    const bytes = Buffer.from('[[1e309,0],[0,1]]')
    const digest = createHash('sha256').update(bytes).digest('hex')
    const blob: W.BytesRef = {
      authorityId: 'synthetic-blob',
      blobId: digest,
      digest,
      bytes: bytes.byteLength,
      mediaType: 'application/json',
      pinId: 'synthetic-pin',
    }
    const overflowing = await readEmbeddingVectors(
      { kind: 'blob', schema: RuntimeSchemaRefs.EmbeddingVectors, blob },
      { ...embeddingInput, normalize: false },
      call,
      {
        async readRange() {
          return { ok: true, value: { bytes, offset: 0, totalBytes: bytes.byteLength, digest } }
        },
        async openRead() {
          throw Error('Range fixture only')
        },
      },
    )
    expect(overflowing.ok).toBe(false)
  })
  it('cross-checks identical results and refusal codes from both selected implementations', async () => {
    const results: unknown[] = []
    for (const kind of ['default', 'reference'] as const) {
      const directory = mkdtempSync(join(tmpdir(), 'embedding-cross-')),
        c = await createEmbeddingConsumer({ directory, kind })
      try {
        results.push([
          await c.encode(),
          ((await c.encode({ ...embeddingInput, dimensions: 3 })) as W.EffectResult).error?.code,
          ((await c.encode(embeddingInput, 'deny')) as W.EffectResult).error?.code,
        ])
      } finally {
        await c.close()
        rmSync(directory, { recursive: true, force: true })
      }
    }
    expect(results[0]).toEqual(results[1])
  })
})
