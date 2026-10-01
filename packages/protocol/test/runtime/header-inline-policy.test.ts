import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { Type } from '@sinclair/typebox'
import type { Ajv2020 as Ajv2020Class } from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import { boundedCanonicalJson, utf8ByteLength } from '../../../protocol-validation/src/byte-budget.js'
import { validateAgainst } from '../../../protocol-validation/src/validate.js'
import {
  MAX_AUTHOR_INLINE_BYTES,
  RuntimeAuthorCodecPolicy,
  RuntimeHttpHeaderPolicy,
} from '../../gen/ts/runtime-catalog.js'
import { validateControlledHttpHeaders } from '../../src/runtime/codec-policy.js'
import { RuntimeSchemas, validateRuntime } from '../../src/runtime/public.js'
import { generateModule } from '../../tools/gen-core.js'

const publicDoc = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../schema/runtime/public.json', import.meta.url)), 'utf8'),
)
const Ajv2020 = createRequire(import.meta.url)('ajv/dist/2020.js').default as typeof Ajv2020Class
const ajv = new Ajv2020({ strict: false })
ajv.addKeyword({
  keyword: 'x-max-utf8-bytes',
  type: 'string',
  schemaType: 'number',
  validate: (limit: number, value: string) => utf8ByteLength(value, limit).ok,
})
ajv.addKeyword({
  keyword: 'x-max-canonical-json-bytes',
  schemaType: 'number',
  validate: (limit: number, value: unknown) =>
    boundedCanonicalJson(value, { maxBytes: limit, maxDepth: 64, maxMembers: 10000 }).ok,
})
const oracle = ajv.compile(publicDoc.$defs.ControlledHttpHeaders)

describe('official header and inline policy', () => {
  it('generates the one policy authority and leaves NetworkRequest headers as DataRef', () => {
    expect(Object.isFrozen(RuntimeAuthorCodecPolicy)).toBe(true)
    expect(Object.isFrozen(RuntimeAuthorCodecPolicy.payload)).toBe(true)
    expect(Object.isFrozen(RuntimeHttpHeaderPolicy.request)).toBe(true)
    expect(RuntimeAuthorCodecPolicy).toEqual(publicDoc['x-author-codec-policy'])
    expect(MAX_AUTHOR_INLINE_BYTES).toBe(RuntimeAuthorCodecPolicy.maxInlineBytes)
    expect(publicDoc.$defs.NetworkRequest.properties.headers).toEqual({
      $ref: 'prototype.json#/$defs/DataRef',
    })
    expect(validateRuntime('Limits', { MAX_INLINE_DATA_BYTES: 1048576 }).ok).toBe(true)
    expect(validateRuntime('Limits', { MAX_INLINE_DATA_BYTES: 1048577 }).ok).toBe(false)
  })
  it('enforces every direction from the generated policy and denies all unlisted headers', () => {
    for (const name of RuntimeHttpHeaderPolicy.request)
      expect(validateControlledHttpHeaders('request', { [name]: 'text' }).ok).toBe(true)
    for (const name of RuntimeHttpHeaderPolicy.response)
      expect(validateControlledHttpHeaders('response', { [name]: 'text' }).ok).toBe(true)
    expect(validateControlledHttpHeaders('request', { location: '/public' }).ok).toBe(false)
    expect(validateControlledHttpHeaders('response', { 'user-agent': 'test' }).ok).toBe(false)
    for (const name of [
      'Authorization',
      'authorization',
      'cookie',
      'set-cookie',
      'x-api-key',
      'x-auth-token',
      'content-length',
      'x-unknown',
    ]) {
      expect(validateControlledHttpHeaders('request', { [name]: 'x' }).ok).toBe(false)
    }
  })
  it('matches AJV on original UTF-8 and canonical bytes, not UTF-16 string length', () => {
    const samples = [
      {},
      { accept: 'é'.repeat(4096) },
      { accept: 'é'.repeat(4097) },
      { accept: 'a'.repeat(8192) },
      { accept: 'a'.repeat(8193) },
      { accept: '\t' },
      { accept: 'a\r\nb' },
      { accept: '\ud800' },
      Object.fromEntries(RuntimeHttpHeaderPolicy.response.map((name) => [name, 'a'.repeat(8192)])),
    ]
    for (const sample of samples)
      expect(validateRuntime('ControlledHttpHeaders', sample).ok).toBe(oracle(sample))
    expect(validateRuntime('ControlledHttpHeaders', { accept: 'é'.repeat(4097) }).ok).toBe(false)
    expect(
      validateRuntime(
        'ControlledHttpHeaders',
        Object.fromEntries(RuntimeHttpHeaderPolicy.response.map((name) => [name, 'a'.repeat(8192)])),
      ).ok,
    ).toBe(false)
  })
  it('keeps byte assertions on refs and selects unions using both shape and byte constraints', () => {
    const small = Object.assign(Type.String({ $id: 'Small' }), { 'x-max-utf8-bytes': 2 })
    const reference = Type.Module({
      Small: small,
      Wrapper: Type.Object({ value: Type.Ref('Small') }),
    }).Import('Wrapper')
    expect(validateAgainst(reference, { value: 'é' }).ok).toBe(true)
    expect(validateAgainst(reference, { value: 'éé' }).ok).toBe(false)
    const union = Type.Union([
      small,
      Object.assign(Type.String({ pattern: '^ok' }), { 'x-max-utf8-bytes': 10 }),
    ])
    expect(validateAgainst(union, 'éé').ok).toBe(false)
    expect(validateAgainst(union, 'okay').ok).toBe(true)
    expect(
      RuntimeSchemas.ControlledHttpHeaders.$defs.ControlledHttpHeaders['x-max-canonical-json-bytes'],
    ).toBe(65536)
  })
  it('fails generation on wrong byte keyword types, wrong placement, and unknown byte keywords', () => {
    for (const schema of [
      { type: 'string', 'x-max-utf8-bytes': 0 },
      { type: 'string', 'x-max-utf8-bytes': 1.5 },
      { type: 'object', additionalProperties: false, 'x-max-utf8-bytes': 1 },
      { type: 'string', 'x-max-utf8-byte': 2 },
      { not: { type: 'string', 'x-max-utf8-bytes': 2 } },
    ]) {
      expect(() => generateModule({ $defs: { Header: schema } }, 'Test', 'test.json')).toThrow()
    }
    expect(() =>
      generateModule(
        {
          $defs: {
            Small: { type: 'string', 'x-max-utf8-bytes': 2 },
            Negative: { not: { $ref: '#/$defs/Small' } },
          },
        },
        'Test',
        'test.json',
      ),
    ).toThrow(/under not/)
    const output = generateModule(
      { $defs: { Header: publicDoc.$defs.ControlledHttpHeaders } },
      'Test',
      'test.json',
    )
    expect(output).toContain('x-max-utf8-bytes')
    expect(output).toContain('x-max-canonical-json-bytes')
  })
})
