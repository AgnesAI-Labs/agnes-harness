import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import type { Ajv2020 as Ajv2020Class } from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import { jcs } from '../../src/jcs.js'
import { RuntimeMethodSchemaRefs, RuntimeSchemaRefs } from '../../src/runtime/index.js'
import { canonicalJsonDigest } from '../../src/runtime/jcs-digest.js'
import { generateModule } from '../../tools/gen-core.js'
import { generateLocalAPI, loadRuntimeSchemaGraph } from '../../tools/gen-runtime-full.js'
import { generateRuntimeReferences, runtimeSchemaDocument } from '../../tools/gen-runtime-refs.js'

const require = createRequire(import.meta.url)
const Ajv2020 = require('ajv/dist/2020.js').default as typeof Ajv2020Class

describe('runtime schema generation', () => {
  it('enforces object and dictionary property counts with JSON Schema parity', () => {
    for (const schema of [
      {
        type: 'object',
        properties: { a: { type: 'string' }, b: { type: 'string' }, c: { type: 'string' } },
        additionalProperties: false,
        minProperties: 1,
        maxProperties: 2,
      },
      { type: 'object', additionalProperties: { type: 'string' }, minProperties: 1, maxProperties: 2 },
    ]) {
      const source = generateModule({ $defs: { Bounded: schema } }, 'Bounds')
        .split('\n')
        .filter((line) => !line.startsWith('import ') && !line.startsWith('export type '))
        .join('\n')
        .replaceAll('export const ', 'const ')
      const generated = runInNewContext(`${source}\nBounded`, { Type })
      const validate = new Ajv2020().compile(schema)
      for (const [value, expected] of [
        [{}, false],
        [{ a: 'x' }, true],
        [{ a: 'x', b: 'y' }, true],
        [{ a: 'x', b: 'y', c: 'z' }, false],
        [{ a: 1 }, false],
      ] as const) {
        expect(validate(value)).toBe(expected)
        expect(Value.Check(generated, value)).toBe(expected)
      }
    }
  })

  it('preserves optional dictionary validators with referenced values and key limits', () => {
    const schema = {
      $defs: {
        Token: { type: 'string', maxLength: 8 },
        Skin: {
          type: 'object',
          additionalProperties: false,
          properties: {
            tokens: {
              type: 'object',
              propertyNames: { pattern: '^[a-z]+$' },
              additionalProperties: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  light: { $ref: '#/$defs/Token' },
                  dark: { $ref: '#/$defs/Token' },
                },
                required: ['light', 'dark'],
              },
              maxProperties: 2,
            },
          },
        },
      },
      $ref: '#/$defs/Skin',
    }
    const source = generateModule(schema, 'Tokens')
      .split('\n')
      .filter((line) => !line.startsWith('import ') && !line.startsWith('export type '))
      .join('\n')
      .replaceAll('export const ', 'const ')
    const generated = runInNewContext(`${source}\nSkin`, { Type })
    const validate = new Ajv2020().compile(schema)
    for (const [value, expected] of [
      [{}, true],
      [{ tokens: { accent: { light: 'white', dark: 'black' } } }, true],
      [{ tokens: 'text' }, false],
      [{ tokens: { accent: { light: 1, dark: 'black' } } }, false],
      [{ tokens: { accent: { light: 'white' } } }, false],
      [{ tokens: { 'bad key': { light: 'white', dark: 'black' } } }, false],
      [{ tokens: { accent: { light: '123456789', dark: 'black' } } }, false],
      [{ tokens: Object.fromEntries(['a', 'b', 'c'].map((key) => [key, { light: 'x', dark: 'y' }])) }, false],
    ] as const) {
      expect(validate(value)).toBe(expected)
      expect(Value.Check(generated, value)).toBe(expected)
    }
  })

  it('resolves legacy schemas through named aliases without overriding Runtime definitions', () => {
    const { document } = loadRuntimeSchemaGraph(
      fileURLToPath(new URL('../../schema/runtime', import.meta.url)),
    )
    expect(document.$defs?.UIOpeningResult?.$ref).toMatch(/^#\/\$defs\/Externalagnes_v1_/)
    expect(document.$defs?.UInt53?.maximum).toBe(Number.MAX_SAFE_INTEGER)
    expect(document.$defs?.RuntimeProfile).toBeDefined()
  })

  it('fails Local generation for unresolved Wire types', () => {
    expect(() =>
      generateLocalAPI(
        {
          'x-local-api': { runtime: { Port: 'interface Port { read(): Wire.Missing; }' }, client: {} },
        },
        new Set(),
      ),
    ).toThrow('unknown Local type Port: Missing')
  })

  it('refuses a second authority that overrides an existing Wire definition', () => {
    const directory = mkdtempSync(join(tmpdir(), 'runtime-schema-authority-'))
    try {
      writeFileSync(
        join(directory, 'prototype.json'),
        JSON.stringify({ $defs: { UInt53: { type: 'integer' } } }),
      )
      writeFileSync(join(directory, 'public.json'), JSON.stringify({ $defs: { UInt53: { type: 'number' } } }))
      expect(() => loadRuntimeSchemaGraph(directory)).toThrow('duplicate runtime schema authority for UInt53')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('canonical JSON digest', () => {
  it('matches SHA-256 over exact JCS UTF-8 bytes across padding boundaries', () => {
    for (const value of [
      null,
      {},
      [],
      '你好🙂',
      { z: 0, a: [true, false, -0, 1e30] },
      ...[54, 55, 56, 63, 64, 65, 127, 128, 1024].map((length) => 'x'.repeat(length)),
    ]) {
      const expected = createHash('sha256').update(jcs(value), 'utf8').digest('hex')
      expect(canonicalJsonDigest(value)).toBe(expected)
    }
    expect(canonicalJsonDigest(null)).toBe('74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b')
    expect(canonicalJsonDigest({ b: 1, a: 2 })).toBe(canonicalJsonDigest({ a: 2, b: 1 }))
  })

  it('rejects values outside canonical JSON before hashing', () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    for (const value of [
      undefined,
      new Date(),
      () => null,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '\ud800',
      cycle,
    ])
      expect(() => canonicalJsonDigest(value as never)).toThrow('invalid JCS input')
  })
})

describe('generated schema reference identities', () => {
  const root = { type: 'object', properties: { child: { $ref: '#/$defs/Child' } } }
  const child = { anyOf: [{ type: 'null' }, { $ref: '#/$defs/Root' }] }
  const graph = { $defs: { Root: root, Child: child, Unrelated: { type: 'boolean' } } }
  const metadata = {
    'x-schema-ids': { Root: 'fixture/root@1' },
    'x-service-catalog': {
      'fixture.loop': {
        methods: {
          start: {
            input: 'Root',
            output: 'Child',
            inputTypeId: 'fixture/start.request@1',
            outputTypeId: 'fixture/start.response@1',
          },
          resume: {
            input: 'Root',
            output: 'Child',
            inputTypeId: 'fixture/resume.request@1',
            outputTypeId: 'fixture/resume.response@1',
          },
          local: { local: true, localInterface: 'Port', localMethod: 'open' },
        },
      },
    },
  }

  it('hashes the exact complete cyclic document independently of its type identity', () => {
    const expectedDocument = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $ref: '#/$defs/Root',
      $defs: { Root: root, Child: child },
    }
    const expectedDigest = createHash('sha256').update(jcs(expectedDocument), 'utf8').digest('hex')
    expect(runtimeSchemaDocument(graph, 'Root')).toEqual(expectedDocument)
    const refs = generateRuntimeReferences(graph, metadata)
    expect(refs.RuntimeSchemaRefs.Root).toEqual({
      typeId: 'fixture/root@1',
      revision: 1,
      digest: expectedDigest,
    })
    const methods = refs.RuntimeMethodSchemaRefs['fixture.loop']
    expect(methods?.start?.input.digest).toBe(methods?.resume?.input.digest)
    expect(methods?.start?.input.typeId).not.toBe(methods?.resume?.input.typeId)
    expect(methods).not.toHaveProperty('local')
  })

  it('applies registered revisions consistently to official and method references', () => {
    const refs = generateRuntimeReferences(graph, {
      ...metadata,
      'x-schema-revisions': { Root: 2, Child: 3 },
    })
    expect(refs.RuntimeSchemaRefs.Root?.revision).toBe(2)
    expect(refs.RuntimeSchemaRefs.Root?.typeId).toBe('fixture/root@1')
    expect(refs.RuntimeMethodSchemaRefs['fixture.loop']?.start?.input.revision).toBe(2)
    expect(refs.RuntimeMethodSchemaRefs['fixture.loop']?.resume?.output.revision).toBe(3)
    for (const revisions of [
      [],
      null,
      { Missing: 2 },
      { Root: 0 },
      { Root: -0 },
      { Root: 1.5 },
      { Root: Number.MAX_SAFE_INTEGER + 1 },
      { Root: '2' },
    ])
      expect(() =>
        generateRuntimeReferences(graph, { ...metadata, 'x-schema-revisions': revisions }),
      ).toThrow('invalid runtime schema revision')
  })

  it('changes a digest only for changes in its reachable schema closure', () => {
    const original = generateRuntimeReferences(graph, metadata).RuntimeSchemaRefs.Root?.digest
    const unrelated = structuredClone(graph)
    unrelated.$defs.Unrelated.type = 'string'
    expect(generateRuntimeReferences(unrelated, metadata).RuntimeSchemaRefs.Root?.digest).toBe(original)
    const reachable = structuredClone(graph)
    reachable.$defs.Child.anyOf[0] = { type: 'boolean' }
    expect(generateRuntimeReferences(reachable, metadata).RuntimeSchemaRefs.Root?.digest).not.toBe(original)
  })

  it('rejects unresolved references, type major changes and conflicting identities', () => {
    expect(() => runtimeSchemaDocument({ $defs: { Root: { $ref: '#/$defs/Missing' } } }, 'Root')).toThrow(
      'unresolved digest definition Missing',
    )
    expect(() =>
      generateRuntimeReferences(graph, { ...metadata, 'x-schema-ids': { Root: 'fixture/root@2' } }),
    ).toThrow('explicit @1 typeId')
    const conflicting = { ...metadata, 'x-schema-ids': { Root: 'fixture/root@1', Child: 'fixture/root@1' } }
    expect(() => generateRuntimeReferences(graph, conflicting)).toThrow('conflicting runtime schema identity')
  })

  it('deep freezes official references and preserves each Loop method identity', () => {
    expect(Object.isFrozen(RuntimeSchemaRefs)).toBe(true)
    expect(Object.isFrozen(RuntimeSchemaRefs.StandardToolOutput)).toBe(true)
    expect(Object.isFrozen(RuntimeMethodSchemaRefs['agh.loop'].start.input)).toBe(true)
    expect(RuntimeMethodSchemaRefs['agh.loop'].start.input.typeId).toBe('agh.loop/start.request@1')
    expect(RuntimeMethodSchemaRefs['agh.loop'].resume.input.typeId).toBe('agh.loop/resume.request@1')
    expect(RuntimeMethodSchemaRefs['agh.loop'].start.input.digest).toBe(
      RuntimeMethodSchemaRefs['agh.loop'].resume.input.digest,
    )
  })
})
