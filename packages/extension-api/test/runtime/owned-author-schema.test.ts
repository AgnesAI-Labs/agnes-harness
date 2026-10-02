import { readFileSync } from 'node:fs'
import {
  canonicalJsonDigest,
  defineGeneratedAuthorSchema,
  defineTool,
  runtimeAuthorSchemas,
} from '@agnes/extension-api/runtime'
import { describe, expect, it } from 'vitest'
import { validateRuntime } from '../../../protocol/src/runtime/public.js'
import { normalizeAuthorSchemaDocument } from '../../../protocol/tools/author-schema-document.js'

function codec() {
  return defineGeneratedAuthorSchema<Readonly<{ message: string }>>({
    ownerPackageId: '@example/plugin',
    name: 'Message',
    typeId: '@example/plugin/message@1',
    revision: 1,
    document: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $ref: '#/$defs/Message',
      $defs: {
        Message: {
          type: 'object',
          properties: { message: { type: 'string' } },
          required: ['message'],
          additionalProperties: false,
        },
      },
    },
  })
}
describe('generated author codecs', () => {
  it('shares official declaration trust while rejecting cloned codecs', () => {
    const input = codec()
    expect(
      defineTool({
        id: 'message',
        description: 'Return message',
        execution: 'pure',
        input,
        execute: (value) => ({ content: [], structured: value }),
      }),
    ).toBeDefined()
    expect(
      defineTool({
        id: 'official',
        description: 'Return result',
        execution: 'pure',
        input: runtimeAuthorSchemas.StandardToolOutput,
        execute: (value) => ({ content: [], structured: value }),
      }),
    ).toBeDefined()
    expect(() =>
      defineTool({
        id: 'forged',
        description: 'Return message',
        execution: 'pure',
        input: { ...input },
        execute: (value) => ({ content: [], structured: value }),
      }),
    ).toThrow()
  })
  it('copies frozen parsed data and encodes exact canonical digest and bytes', () => {
    const schema = codec(),
      input = { message: '😀' },
      parsed = schema.parse(input)
    expect(parsed.ok).toBe(true)
    input.message = 'changed'
    if (!parsed.ok) throw new Error('parse failed')
    expect(parsed.value.message).toBe('😀')
    expect(Object.isFrozen(parsed.value)).toBe(true)
    const encoded = schema.encode(parsed.value)
    if (!encoded.ok || encoded.value.kind !== 'inline') throw new Error('encode failed')
    expect(encoded.value.bytes).toBe(Buffer.byteLength('{"message":"😀"}'))
    expect(encoded.value.digest).toBe(canonicalJsonDigest({ message: '😀' }))
    expect(schema.parse({ message: 1 }).ok).toBe(false)
    expect(schema.parse({ message: 'okay', extra: true }).ok).toBe(false)
  })
  it('consumes the canonical empty authority with a scoped codec through the formal DataRef validator', () => {
    const document = normalizeAuthorSchemaDocument(
      JSON.parse(
        readFileSync(
          new URL('../../../protocol/schema/runtime/empty-config.schema.json', import.meta.url),
          'utf8',
        ),
      ),
      'RuntimeEmptyConfig',
    )
    const schema = defineGeneratedAuthorSchema<Record<string, never>>({
      ownerPackageId: '@example/plugin',
      name: 'RuntimeEmptyConfig',
      typeId: '@example/plugin/runtime-empty@1',
      revision: 1,
      document,
    })
    const encoded = schema.encode({})
    if (!encoded.ok) throw new Error('empty encode failed')
    expect(validateRuntime('SchemaRef', schema.ref).ok).toBe(true)
    expect(validateRuntime('DataRef', encoded.value).ok).toBe(true)
    expect(schema.parse({ extra: true }).ok).toBe(false)
    expect(schema.ref.typeId).toBe('@example/plugin/runtime-empty@1')
  })
  it('fails oversized encoding without manufacturing Blob references or doing IO', () => {
    const schema = codec(),
      result = schema.encode({ message: 'x'.repeat(65536) })
    expect(schema.parse({ message: 'x'.repeat(65536) }).ok).toBe(true)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('quota accepted')
    expect(result.error.code).toBe('quota')
    expect(result.error.detailCode).toBe('inline_data_bytes')
    const official = runtimeAuthorSchemas.StandardToolOutput.encode({
      content: [],
      structured: { text: 'x'.repeat(65536) },
    })
    expect(official.ok).toBe(false)
    if (!official.ok) expect(official.error.code).toBe('quota')
  })
  it('never invokes accessors and preserves numeric metadata refusal', () => {
    let reads = 0
    const payload = Object.defineProperty({}, 'message', {
      enumerable: true,
      get() {
        reads++
        return 'read'
      },
    })
    expect(codec().parse(payload).ok).toBe(false)
    expect(reads).toBe(0)
    expect(() =>
      defineGeneratedAuthorSchema({
        ownerPackageId: '@example/plugin',
        name: 'Message',
        typeId: '@example/plugin/message@1',
        revision: -0,
        document: null,
      }),
    ).toThrow()
  })
})
