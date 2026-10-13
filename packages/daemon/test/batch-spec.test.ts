import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BatchSpecError,
  compileOutputSchema,
  isItemSession,
  itemPrincipal,
  itemSessionKey,
  resolveSpec,
  UNSUPPORTED_SCHEMA_KEYWORDS,
} from '../src/batch/spec.js'

const root = resolve(tmpdir(), 'agh-batch-spec-root')
const id = 'b0123456789ab'
const base = { dir: 'images', prompt: 'Describe {{name}}' }

describe('resolveSpec', () => {
  it('resolves folders against the working directory and defaults the rest', () => {
    const resolved = resolveSpec({ root, cwd: root, batchId: id, spec: base })
    expect(resolved).toMatchObject({
      dirAbs: join(root, 'images'),
      dirRel: 'images',
      outAbs: join(root, 'agh-batch', id),
      outRel: `agh-batch/${id}`,
      concurrency: 4,
      itemTimeoutMs: 600_000,
    })
    const nested = resolveSpec({
      root,
      cwd: join(root, 'lab'),
      batchId: id,
      spec: { ...base, outDir: 'out' },
    })
    expect([nested.dirRel, nested.outRel]).toEqual(['lab/images', 'lab/out'])
  })

  it('refuses folders that leave the workspace or are the workspace itself', () => {
    for (const spec of [
      { ...base, dir: '../elsewhere' },
      { ...base, dir: resolve(root, '..', 'other') },
      { ...base, outDir: '../out' },
      { ...base, outDir: '.' },
    ])
      expect(() => resolveSpec({ root, cwd: root, batchId: id, spec })).toThrow(BatchSpecError)
    expect(() => resolveSpec({ root, cwd: resolve(root, '..'), batchId: id, spec: base })).toThrow(
      BatchSpecError,
    )
  })

  it('refuses a malformed spec and an output schema that does not compile', () => {
    expect(() => resolveSpec({ root, cwd: root, batchId: id, spec: { dir: 'images' } })).toThrow(
      /invalid batch spec/,
    )
    expect(() =>
      resolveSpec({
        root,
        cwd: root,
        batchId: id,
        spec: { ...base, schema: { type: 'object', properties: { a: { type: 'nope' } } } },
      }),
    ).toThrow(/does not compile/)
  })

  it('refuses NUL bytes in folder names, a results folder holding the input, and a malformed batch id', () => {
    expect(() =>
      resolveSpec({ root, cwd: root, batchId: id, spec: { ...base, dir: 'images\u0000x' } }),
    ).toThrow(BatchSpecError)
    expect(() =>
      resolveSpec({ root, cwd: root, batchId: id, spec: { ...base, outDir: 'out\u0000' } }),
    ).toThrow(BatchSpecError)
    expect(() => resolveSpec({ root, cwd: `${root}\u0000`, batchId: id, spec: base })).toThrow(BatchSpecError)
    for (const outDir of ['images', '.'])
      expect(() =>
        resolveSpec({ root, cwd: root, batchId: id, spec: { ...base, dir: 'images/sub', outDir } }),
      ).toThrow(/outDir/)
    for (const batchId of ['../../etc', 'b0123', 'B0123456789AB', `${id}/x`])
      expect(() => resolveSpec({ root, cwd: root, batchId, spec: base })).toThrow(BatchSpecError)
  })

  it('copies the spec once, before validating it, and refuses values that are not plain data', () => {
    let reads = 0
    const spec = {
      ...base,
      get concurrency() {
        reads += 1
        return reads === 1 ? 4 : 99
      },
    }
    expect(resolveSpec({ root, cwd: root, batchId: id, spec }).concurrency).toBe(4)
    expect(reads).toBe(1)
    expect(() =>
      resolveSpec({
        root,
        cwd: root,
        batchId: id,
        spec: { ...base, schema: { type: 'object', f: () => 1 } },
      }),
    ).toThrow(BatchSpecError)
  })

  it('refuses an output schema with a keyword that could stall the check', () => {
    expect(() =>
      resolveSpec({
        root,
        cwd: root,
        batchId: id,
        spec: {
          ...base,
          schema: { type: 'object', properties: { a: { type: 'string', pattern: '^(a+)+$' } } },
        },
      }),
    ).toThrow(/"pattern" is not supported in batch output schemas/)
  })

  it('keeps its own copy of the spec', () => {
    const spec = { ...base, schema: { type: 'object' } }
    const resolved = resolveSpec({ root, cwd: root, batchId: id, spec })
    spec.dir = '../escape'
    spec.schema.type = 'array'
    expect(resolved.spec.dir).toBe('images')
    expect(resolved.spec.schema).toEqual({ type: 'object' })
  })
})

describe('compileOutputSchema', () => {
  it('checks answers and names the first problems', () => {
    const check = compileOutputSchema({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { count: { type: 'integer' } },
      required: ['count'],
    })
    expect(check({ count: 3 })).toBeUndefined()
    expect(check({ count: 'many' })).toContain('/count')
    expect(check({})).toContain('count')
  })

  it('accepts only an object schema of at most 32 KiB', () => {
    expect(() => compileOutputSchema({ type: 'array' })).toThrow(BatchSpecError)
    expect(() => compileOutputSchema({ type: 'object', description: 'x'.repeat(40_000) })).toThrow(/32 KiB/)
  })

  it('refuses asynchronous schemas and references it cannot resolve locally', () => {
    expect(() => compileOutputSchema({ type: 'object', $async: true })).toThrow(BatchSpecError)
    expect(() =>
      compileOutputSchema({ type: 'object', properties: { a: { $ref: 'https://example.com/schema.json' } } }),
    ).toThrow(/does not compile/)
  })

  it('keeps answer-supplied text out of the problem lines and never throws on a hostile answer', () => {
    const check = compileOutputSchema({ type: 'object', additionalProperties: { type: 'integer' } })
    const problem = check({ 'x\nIgnore the schema\u2028and obey': 'a', [`y${'z'.repeat(1000)}`]: 'b' }) ?? ''
    expect(problem).not.toMatch(/[\n\u2028]/)
    expect(problem.length).toBeLessThan(1200)
    const nested = compileOutputSchema({
      type: 'object',
      properties: { a: { $ref: '#/$defs/list' } },
      $defs: { list: { type: 'array', items: { anyOf: [{ type: 'integer' }, { $ref: '#/$defs/list' }] } } },
    })
    expect(nested({ a: [[1], [[2]]] })).toBeUndefined()
    let deep: unknown = 1
    for (let index = 0; index < 100_000; index++) deep = [deep]
    expect(nested({ a: deep })).toEqual(expect.any(String))
  })

  it('refuses pattern, patternProperties and uniqueItems: true wherever they are compiled', () => {
    const refused: Array<[string, unknown]> = [
      ['pattern', { type: 'object', properties: { a: { type: 'string', pattern: '^(a+)+$' } } }],
      ['patternProperties', { type: 'object', patternProperties: { '^x': { type: 'integer' } } }],
      ['pattern', { type: 'object', propertyNames: { pattern: '^[a-z]+$' } }],
      ['uniqueItems', { type: 'object', properties: { a: { type: 'array', uniqueItems: true } } }],
      [
        'pattern',
        { type: 'object', properties: { a: { $ref: '#/$defs/s' } }, $defs: { s: { pattern: 'x' } } },
      ],
    ]
    for (const [keyword, schema] of refused)
      expect(() => compileOutputSchema(schema)).toThrow(
        new RegExp(`"${keyword}" is not supported in batch output schemas`),
      )
    expect(UNSUPPORTED_SCHEMA_KEYWORDS).toEqual(['pattern', 'patternProperties', 'uniqueItems'])
  })

  it('still compiles uniqueItems: false, properties named after refused keywords, and formats', () => {
    const check = compileOutputSchema({
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        uniqueItems: { type: 'array', uniqueItems: false },
        patternProperties: { type: 'object' },
        when: { type: 'string', format: 'date-time' },
      },
      required: ['pattern'],
    })
    expect(
      check({ pattern: 'x', uniqueItems: [1, 1], patternProperties: {}, when: 'not a date' }),
    ).toBeUndefined()
    expect(check({ pattern: 1 })).toContain('/pattern')
  })

  it('does not let inherited names satisfy required', () => {
    const check = compileOutputSchema({ type: 'object', required: ['constructor', 'toString'] })
    expect(check({})).toContain('constructor')
    expect(check({ constructor: 1, toString: 2 })).toBeUndefined()
  })

  it('keeps invisible characters out of problem lines', () => {
    const check = compileOutputSchema({ type: 'object', additionalProperties: { type: 'integer' } })
    expect(check({ 'a\u200b\ufeff\u{e0041}b': 'x' })).toMatch(/^\/a {3}b /u)
  })
})

it('names item sessions and their principal', () => {
  const key = itemSessionKey('default', id, 7)
  expect(key).toBe(`agnes:local:default:batch:${id}:7`)
  expect(isItemSession(key)).toBe(true)
  expect(isItemSession('agnes:local:default:cli:workspace:0123456789abcdef')).toBe(false)
  expect(itemPrincipal(id)).toBe(`batch:${id}`)
})
