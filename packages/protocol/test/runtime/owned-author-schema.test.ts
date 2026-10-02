import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { afterEach, describe, expect, it } from 'vitest'
import { validateOwnedAuthorSchemaSource } from '../../src/runtime/author-schema-source.js'
import type { JsonValue } from '../../src/runtime/public.js'
import { validateRuntime } from '../../src/runtime/public.js'
import { runtimeSchemaDocument } from '../../src/runtime/schema-document.js'
import { normalizeAuthorSchemaDocument } from '../../tools/author-schema-document.js'
import { parseAuthorSchemaJson } from '../../tools/author-schema-json.js'
import { generateOwnedAuthorSchemas, runAuthorSchemaCli } from '../../tools/gen-author-schema.js'

const draft = 'https://json-schema.org/draft/2020-12/schema'
function source(definition: Record<string, unknown>) {
  return {
    ownerPackageId: '@example/plugin',
    name: 'Message',
    typeId: '@example/plugin/message@1',
    revision: 1,
    document: { $schema: draft, $ref: '#/$defs/Message', $defs: { Message: definition } },
  }
}
const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('owned schema documents', () => {
  it('preserves scoped identity and rejects forged parser and digest inputs', () => {
    const checked = validateOwnedAuthorSchemaSource(source({ type: 'string' }))
    expect(checked.ref.typeId).toBe('@example/plugin/message@1')
    expect(checked.ref.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(Object.isFrozen(checked.source.document)).toBe(true)
    for (const extra of [
      { parse: () => '' },
      { digest: '0'.repeat(64) },
      { revision: -0 },
      { ownerPackageId: 'example/plugin' },
      { ownerPackageId: '@example/plugin\u0085', typeId: '@example/plugin\u0085/message@1' },
    ])
      expect(() => validateOwnedAuthorSchemaSource({ ...source({ type: 'string' }), ...extra })).toThrow()
  })
  it('accepts original Wire identities and scoped identities through SchemaRef and DataRef', () => {
    for (const typeId of [
      'agh.state/createRun.request@1',
      'a.b-c/name.with_/path@999999999999999999999',
      '@example/plugin/message@1',
      '@a_b/p.q-r/name@2',
    ]) {
      expect(validateRuntime('TypeId', typeId).ok).toBe(true)
      const ref = { typeId, revision: 1, digest: '0'.repeat(64) }
      expect(validateRuntime('SchemaRef', ref).ok).toBe(true)
      expect(
        validateRuntime('DataRef', {
          kind: 'inline',
          schema: ref,
          value: {},
          bytes: 2,
          digest: '0'.repeat(64),
        }).ok,
      ).toBe(true)
    }
    for (const typeId of [
      '@/plugin/message@1',
      '@example//message@1',
      '@example/Plugin/message@1',
      '@example/plugin/message@0',
      '@example/plugin/message@01',
      '@example/plugin/message@@1',
      '@例/plugin/message@1',
      '@example/plugin/message@1\n',
    ])
      expect(validateRuntime('TypeId', typeId).ok).toBe(false)
    for (const [ownerPackageId, typeId] of [
      ['@example/plugin', '@other/plugin/message@1'],
      ['Upper', 'Upper/message@1'],
      ['@example/plugin', '@example/plugin/message@9007199254740992'],
    ])
      expect(() =>
        validateOwnedAuthorSchemaSource({ ...source({ type: 'string' }), ownerPackageId, typeId }),
      ).toThrow()
    const ownerPackageId = `@a/${'p'.repeat(244)}`
    expect(() =>
      validateOwnedAuthorSchemaSource({
        ...source({ type: 'string' }),
        ownerPackageId,
        typeId: `${ownerPackageId}/message@1`,
      }),
    ).toThrow()
  })
  it('normalizes only offline schema positions and preserves supported graph bytes', () => {
    const unchanged = source({ type: 'string' }).document
    expect(normalizeAuthorSchemaDocument(unchanged, 'Message')).toEqual(unchanged)
    const raw = {
      $schema: draft,
      type: 'object',
      properties: {
        child: { type: 'object', properties: {}, additionalProperties: false },
        type: { const: 'object' },
      },
      additionalProperties: false,
    }
    const normalized = normalizeAuthorSchemaDocument(raw, 'Message')
    const checked = validateOwnedAuthorSchemaSource({ ...source({ type: 'string' }), document: normalized })
    expect(checked.validate({ child: {}, type: 'object' }).ok).toBe(true)
    expect(checked.validate({ child: { extra: true } }).ok).toBe(false)
    expect(raw).not.toHaveProperty('required')
    expect(() => validateOwnedAuthorSchemaSource({ ...source({ type: 'string' }), document: raw })).toThrow()
    const data = { $schema: draft, const: { type: 'object', $ref: '#/$defs/Fake' } }
    const mapped = normalizeAuthorSchemaDocument(data, 'Message') as { $defs: Record<string, unknown> }
    expect(mapped.$defs.Message).toEqual({ const: data.const })
    expect(() =>
      validateOwnedAuthorSchemaSource({ ...source({ type: 'string' }), document: mapped }),
    ).toThrow()
  })
  it('normalizes object schemas under items, unions, definitions and additionalProperties', () => {
    const object = { type: 'object', properties: {}, additionalProperties: false }
    for (const definition of [
      { type: 'array', items: object },
      { anyOf: [object, { type: 'string' }] },
      { type: 'object', properties: {}, additionalProperties: object },
    ]) {
      const document = normalizeAuthorSchemaDocument(source(definition).document, 'Message')
      const checked = validateOwnedAuthorSchemaSource({ ...source({ type: 'string' }), document })
      const value = definition.type === 'array' ? [{}] : definition.anyOf ? {} : { child: {} }
      expect(checked.validate(value).ok).toBe(true)
    }
  })
  it('rejects malformed annotations, ambiguous roots and unsafe non-JSON without executing getters', () => {
    for (const input of [
      { $schema: draft, $id: 1, type: 'string' },
      { $schema: draft, $id: '', type: 'string' },
      { $schema: draft, title: 1, type: 'string' },
      { $schema: draft, $defs: {}, type: 'string' },
      { $schema: draft, $ref: '#/$defs/X', type: 'string' },
      { ...source({ type: 'string' }).document, extra: true },
    ])
      expect(() => normalizeAuthorSchemaDocument(input, 'Message')).toThrow()
    let reads = 0
    const input = Object.defineProperty({ $schema: draft }, 'type', {
      enumerable: true,
      get() {
        reads++
        return 'string'
      },
    })
    expect(() => normalizeAuthorSchemaDocument(input, 'Message')).toThrow()
    expect(reads).toBe(0)
  })
  it('rejects getters without invoking them', () => {
    let reads = 0
    const input = source({ type: 'string' })
    Object.defineProperty(input, 'document', {
      get() {
        reads++
        throw new Error('read')
      },
    })
    expect(() => validateOwnedAuthorSchemaSource(input)).toThrow()
    expect(reads).toBe(0)
  })
  it('matches standard JSON Schema codepoint and bounded integer behavior', () => {
    const definitions = [
      { type: 'string', maxLength: 1 },
      { type: 'integer', minimum: -9007199254740991, maximum: 9007199254740991 },
    ]
    const values = ['😀', 'ab', '', 1, 1.1, 1e20, -9007199254740991]
    const ajv = new Ajv2020({ strict: true })
    for (const definition of definitions) {
      const input = source(definition),
        checked = validateOwnedAuthorSchemaSource(input),
        oracle = ajv.compile(input.document)
      for (const value of values) expect(checked.validate(value).ok).toBe(oracle(value))
    }
    expect(() => validateOwnedAuthorSchemaSource(source({ type: 'integer' }))).toThrow()
  })
  it('matches AJV across the supported structural and scalar subset', () => {
    const definitions: Record<string, unknown>[] = [
      { type: 'null' },
      { type: 'boolean' },
      { const: null },
      { enum: [null, true, 3, 'a'] },
      { type: 'number', exclusiveMinimum: 0, maximum: 3 },
      { type: 'array', items: { type: 'number', minimum: 0 }, minItems: 1, maxItems: 2 },
      {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: { type: 'string' },
        minProperties: 1,
        maxProperties: 2,
      },
      {
        anyOf: [
          { type: 'number', minimum: 0 },
          { type: 'number', maximum: 3 },
        ],
      },
      { $ref: '#/$defs/Other' },
    ]
    const values: JsonValue[] = [
      null,
      true,
      false,
      0,
      1,
      3,
      -1,
      3.1,
      'a',
      '😀',
      [],
      [1],
      [1, 2],
      [1, 2, 3],
      [-1],
      {},
      { name: 'a' },
      { name: 1 },
      { name: 'a', extra: 'x' },
      { one: 'a', two: 'b' },
      { one: 'a', two: 'b', three: 'c' },
    ]
    for (const definition of definitions) {
      const input = source(definition)
      if (definition.$ref) Object.assign(input.document.$defs, { Other: { type: 'string' } })
      const checked = validateOwnedAuthorSchemaSource(input),
        oracle = new Ajv2020({ strict: true }).compile(input.document)
      for (const value of values) expect(checked.validate(value).ok).toBe(oracle(value))
    }
  })
  it('enforces both byte keywords and rejects unknown schema semantics', () => {
    const utf8 = validateOwnedAuthorSchemaSource(source({ type: 'string', 'x-max-utf8-bytes': 4 }))
    expect(utf8.validate('😀').ok).toBe(true)
    expect(utf8.validate('😀a').ok).toBe(false)
    const canonical = validateOwnedAuthorSchemaSource(
      source({ type: 'string', 'x-max-canonical-json-bytes': 6 }),
    )
    expect(canonical.validate('😀').ok).toBe(true)
    expect(canonical.validate('😀a').ok).toBe(false)
    for (const definition of [
      { type: 'string', pattern: 'a' },
      { type: 'string', 'x-unknown': 1 },
    ])
      expect(() => validateOwnedAuthorSchemaSource(source(definition))).toThrow()
  })
  it('treats a property named $ref as business data and rejects cyclic references', () => {
    const definition = {
      type: 'object',
      properties: { $ref: { type: 'string' } },
      required: ['$ref'],
      additionalProperties: false,
    }
    expect(runtimeSchemaDocument({ $defs: { Message: definition } }, 'Message').$defs.Message).toEqual(
      definition,
    )
    expect(validateOwnedAuthorSchemaSource(source(definition)).validate({ $ref: 'hello' }).ok).toBe(true)
    expect(() => validateOwnedAuthorSchemaSource(source({ $ref: '#/$defs/Message' }))).toThrow()
  })
  it('bounds graph depth, definitions and repeated validation work', () => {
    let nested: Record<string, unknown> = { type: 'string' }
    for (let index = 0; index < 33; index++) nested = { type: 'array', items: nested }
    expect(() => validateOwnedAuthorSchemaSource(source(nested))).toThrow()
    const union = validateOwnedAuthorSchemaSource(
      source({ anyOf: Array.from({ length: 16 }, () => ({ type: 'array', items: { type: 'string' } })) }),
    )
    const result = union.validate([...Array.from({ length: 7000 }, () => 'valid'), 1])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]?.key).toBe('maxWork')
    const input = source({ type: 'string' })
    Object.assign(
      input.document.$defs,
      Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`Extra${index}`, { type: 'string' }])),
    )
    expect(() => validateOwnedAuthorSchemaSource(input)).toThrow()
  })
  it('rejects escaped duplicate JSON keys', () => {
    expect(() => parseAuthorSchemaJson('{"type":"string","t\\u0079pe":"number"}')).toThrow()
  })
})

describe('schema source generation', () => {
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'author-schema-'))
    directories.push(root)
    mkdirSync(join(root, 'schemas'))
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@example/plugin', version: '1.0.0' }))
    writeFileSync(
      join(root, 'schemas/message.json'),
      JSON.stringify(source({ type: 'string', maxLength: 1 }).document),
    )
    const sources = [
      { name: 'Message', typeId: '@example/plugin/message@1', revision: 1, source: './schemas/message.json' },
    ]
    writeFileSync(join(root, 'sources.json'), JSON.stringify(sources))
    writeFileSync(join(root, 'locked.json'), '[]')
    const args = [
      'generate',
      '--package',
      root,
      '--sources',
      join(root, 'sources.json'),
      '--locked-schemas',
      join(root, 'locked.json'),
      '--out',
      'generated',
    ]
    return { root, sources, args }
  }
  it('generates fixed constructors and detects changed source output without overwriting prior success', () => {
    const { root, sources, args } = fixture()
    const generated = generateOwnedAuthorSchemas({ packageRoot: root, sources, lockedSchemas: [] })
    expect(generated['Message.ts']).toContain('defineGeneratedAuthorSchema')
    expect(generated['Message.ts']).toContain('export type MessageValue')
    runAuthorSchemaCli(args)
    runAuthorSchemaCli([...args, '--check'])
    const prior = readFileSync(join(root, 'generated/Message.ts'), 'utf8')
    writeFileSync(
      join(root, 'schemas/message.json'),
      JSON.stringify(source({ type: 'string', pattern: '.' }).document),
    )
    expect(() => runAuthorSchemaCli(args)).toThrow()
    expect(readFileSync(join(root, 'generated/Message.ts'), 'utf8')).toBe(prior)
  })
  it('generates the real empty authority from standalone source and rejects stale or invalid output atomically', () => {
    const { root, args } = fixture()
    const actual = readFileSync(
      new URL('../../schema/runtime/empty-config.schema.json', import.meta.url),
      'utf8',
    )
    writeFileSync(join(root, 'schemas/message.json'), actual)
    runAuthorSchemaCli(args)
    runAuthorSchemaCli([...args, '--check'])
    const prior = readFileSync(join(root, 'generated/Message.ts'), 'utf8')
    expect(prior).toContain('"required":[]')
    const raw = JSON.parse(actual)
    for (const invalid of [
      { ...raw, required: null },
      { ...raw, additionalProperties: undefined },
      { ...raw, 'x-unknown': true },
    ]) {
      writeFileSync(join(root, 'schemas/message.json'), JSON.stringify(invalid))
      expect(() => runAuthorSchemaCli(args)).toThrow()
      expect(readFileSync(join(root, 'generated/Message.ts'), 'utf8')).toBe(prior)
    }
    writeFileSync(join(root, 'schemas/message.json'), `${actual} `)
    expect(() => runAuthorSchemaCli([...args, '--check'])).toThrow(/output differs/)
    expect(readFileSync(join(root, 'generated/Message.ts'), 'utf8')).toBe(prior)
  })
  it('preserves unrelated files and rejects source paths escaping the package', () => {
    const { root, args } = fixture()
    runAuthorSchemaCli(args)
    writeFileSync(join(root, 'generated/unrelated.txt'), 'keep')
    expect(() => runAuthorSchemaCli(args)).toThrow()
    expect(readFileSync(join(root, 'generated/unrelated.txt'), 'utf8')).toBe('keep')
    expect(() =>
      generateOwnedAuthorSchemas({
        packageRoot: root,
        sources: [
          { name: 'Message', typeId: '@example/plugin/message@1', revision: 1, source: '../outside.json' },
        ],
        lockedSchemas: [],
      }),
    ).toThrow()
  })
  it('keeps the real generated consumer fixture in sync with its source', () => {
    const root = fileURLToPath(
      new URL('../../../extension-api/test/runtime/fixtures/owned-source', import.meta.url),
    )
    const sources = JSON.parse(readFileSync(join(root, 'sources.json'), 'utf8')) as Parameters<
      typeof generateOwnedAuthorSchemas
    >[0]['sources']
    const output = generateOwnedAuthorSchemas({ packageRoot: root, sources, lockedSchemas: [] })
    const fixture = fileURLToPath(
      new URL('../../../extension-api/test/runtime/generated/owned-schema/Message.ts', import.meta.url),
    )
    expect(readFileSync(fixture, 'utf8')).toBe(output['Message.ts'])
    const collision = fileURLToPath(
      new URL(
        '../../../extension-api/test/runtime/generated/owned-schema/defineGeneratedAuthor.ts',
        import.meta.url,
      ),
    )
    expect(readFileSync(collision, 'utf8')).toBe(output['defineGeneratedAuthor.ts'])
  })
  it('resolves locked dependency files and refuses byte or namespace drift', () => {
    const { root, sources, args } = fixture()
    const dependency = mkdtempSync(join(tmpdir(), 'author-dependency-'))
    directories.push(dependency)
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: '@example/plugin',
        version: '1.0.0',
        dependencies: { '@example/shared': '^1.0.0' },
      }),
    )
    writeFileSync(
      join(dependency, 'package.json'),
      JSON.stringify({ name: '@example/shared', version: '1.0.0' }),
    )
    const bytes = JSON.stringify({
      $schema: draft,
      $ref: '#/$defs/Shared',
      $defs: { Shared: { type: 'string', maxLength: 1 } },
    })
    writeFileSync(join(dependency, 'shared.json'), bytes)
    writeFileSync(
      join(root, 'schemas/message.json'),
      JSON.stringify(source({ $ref: 'pkg:@example/shared/Shared#/$defs/Shared' }).document),
    )
    const locked = {
      packageId: '@example/shared',
      version: '1.0.0',
      packageDigest: '1'.repeat(64),
      manifestDigest: '2'.repeat(64),
      packageRoot: dependency,
      sources: [
        {
          name: 'Shared',
          typeId: '@example/shared/shared@1',
          revision: 1,
          path: './shared.json',
          fileDigest: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    }
    const output = generateOwnedAuthorSchemas({ packageRoot: root, sources, lockedSchemas: [locked] })
    expect(output['Message.ts']).toContain('maxLength')
    expect(output['schema-sources.generated.json']).not.toContain(dependency)
    expect(() =>
      generateOwnedAuthorSchemas({
        packageRoot: root,
        sources,
        lockedSchemas: [
          {
            ...locked,
            sources: [
              {
                ...locked.sources[0],
                name: 'Shared',
                typeId: '@other/shared/shared@1',
                revision: 1,
                path: './shared.json',
                fileDigest: '0'.repeat(64),
              },
            ],
          },
        ],
      }),
    ).toThrow()
    writeFileSync(join(root, 'locked.json'), JSON.stringify([locked]))
    runAuthorSchemaCli(args)
    const prior = readFileSync(join(root, 'generated/Message.ts'), 'utf8')
    const otherBytes = JSON.stringify({
      $schema: draft,
      $ref: '#/$defs/Other',
      $defs: { Other: { type: 'number' } },
    })
    writeFileSync(join(dependency, 'other.json'), otherBytes)
    const conflicting = {
      ...locked,
      sources: [
        ...locked.sources,
        {
          name: 'Other',
          typeId: '@example/shared/shared@1',
          revision: 1,
          path: './other.json',
          fileDigest: createHash('sha256').update(otherBytes).digest('hex'),
        },
      ],
    }
    writeFileSync(join(root, 'locked.json'), JSON.stringify([conflicting]))
    expect(() => runAuthorSchemaCli(args)).toThrow(/duplicate source identity/)
    expect(() => runAuthorSchemaCli([...args.slice(0, -1), 'fresh-output'])).toThrow(
      /duplicate source identity/,
    )
    expect(existsSync(join(root, 'fresh-output'))).toBe(false)
    expect(readFileSync(join(root, 'generated/Message.ts'), 'utf8')).toBe(prior)
    writeFileSync(join(dependency, 'shared.json'), `${bytes} `)
    expect(() => generateOwnedAuthorSchemas({ packageRoot: root, sources, lockedSchemas: [locked] })).toThrow(
      /bytes mismatch/,
    )
  })
})
