import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  describeValidationErrors,
  toRpcError,
  type ValidationError,
  validateEvent,
  validateOpState,
} from '../src/index.js'
// DATA_DEFS is not on the root export surface — internal pieces of the generated module are not
// spread onto `@agnes/protocol`'s root export — so tests that need it import the implementation
// module directly.
import { DATA_DEFS } from '../src/validate.js'

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const base = {
  seq: 1,
  ts: '2026-09-07T00:00:00Z',
  id: '01J6ZM2Q3R4S5T6V7W8X9Y0ZAB',
  actor,
  origin: 'principal',
  trust: 'trusted',
}

describe('validateEvent', () => {
  it('accepts a user/message', () => {
    const r = validateEvent({
      ...base,
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'hi' }] },
    })
    expect(r.ok).toBe(true)
  })
  it('rejects unknown envelope key with UNKNOWN_KEY and key name', () => {
    const r = validateEvent({
      ...base,
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'hi' }] },
      seams: {},
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors[0]).toMatchObject({ code: 'UNKNOWN_KEY', key: 'seams' })
      expect(toRpcError(r.errors)).toMatchObject({
        code: -32602,
        data: { code: 'UNKNOWN_KEY', key: 'seams' },
      })
    }
  })
  it('rejects missing required envelope field', () => {
    const { trust: _t, ...noTrust } = {
      ...base,
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'hi' }] },
    }
    const r = validateEvent(noTrust)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors[0]).toMatchObject({ code: 'MISSING', key: 'trust' })
      expect(describeValidationErrors(r.errors)).toContain('/trust')
    }
  })
  it('validates data by type in stage two', () => {
    const r = validateEvent({
      ...base,
      type: 'tool/result',
      data: { toolUseId: 't1', content: [], isError: false, authz: { decisionId: 'n/a' } },
    })
    expect(r.ok).toBe(false) // missing enforcement
    if (!r.ok) {
      expect(r.errors[0]).toMatchObject({ code: 'MISSING', key: 'enforcement', path: '/data' })
      expect(describeValidationErrors(r.errors)).toContain('/data/enforcement')
    }
  })
  // Stage two is now on for all 30 names in the closed set, so the only data this package waves
  // through is an extension event's, whose shape it deliberately does not know.
  it('lets data through only for extension event types', () => {
    expect(validateEvent({ ...base, type: 'x/agnes/whatever', data: { anything: 1 } }).ok).toBe(true)
    expect(validateEvent({ ...base, type: 'cost/ledger', data: { anything: 1 } }).ok).toBe(false)
  })
  // The fallback the line above depends on: a name in the closed set with no table entry is refused
  // rather than waved through. It cannot arise from the checked-in schema (the table is derived from
  // x-agnes-data, which covers all 30), so the branch is walked by removing an entry here.
  it('refuses a closed-set type whose data schema went missing', () => {
    const def = DATA_DEFS['cost/ledger'] as (typeof DATA_DEFS)[string]
    delete DATA_DEFS['cost/ledger']
    try {
      const r = validateEvent({ ...base, type: 'cost/ledger', data: {} })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.errors[0]).toMatchObject({ path: '/type', message: 'no data schema' })
    } finally {
      DATA_DEFS['cost/ledger'] = def
    }
  })
  it('accepts extension events and rejects unknown types', () => {
    for (const type of ['x/approval/review', 'x/approval/reservation'])
      expect(validateEvent({ ...base, type, data: {}, ignorable: true }).ok).toBe(true)
    expect(validateEvent({ ...base, type: 'x/acme/report.ready', data: {}, ignorable: true }).ok).toBe(true)
    expect(validateEvent({ ...base, type: 'x/acme/', data: {}, ignorable: true }).ok).toBe(false)
    expect(validateEvent({ ...base, type: 'x/agnes/subagent/worktree-skipped', data: {} }).ok).toBe(true)
    const r = validateEvent({ ...base, type: 'bogus/type', data: {} })
    expect(r.ok).toBe(false)
  })

  // Three runtime assertions for the three schema additions that schema-files.test.ts only covers
  // structurally, by reading the JSON document. These run the real two-stage validateEvent() to prove
  // the generated TypeBox types genuinely validate against those constraints.
  it('C3: ToolCall with depth: 1 is valid', () => {
    const r = validateEvent({
      ...base,
      type: 'tool/call',
      data: { toolUseId: 't1', name: 'run', args: {}, ordinal: 0, depth: 1 },
    })
    expect(r.ok).toBe(true)
  })

  it('C5: OpState deferred phase jobs element missing toolUseId is invalid', () => {
    const validOpState = {
      meta: {
        turn: 1,
        lane: 'main',
        acceptedAt: '2026-09-07T00:00:00Z',
        triggerSeq: 1,
        presetName: 'default',
        profileHash: null,
        depthLimit: 4,
      },
      control: { status: 'running' },
      step: 0,
      latestAssistantSeq: null,
      taint: false,
      phase: { kind: 'deferred', jobs: [{ jobId: 'j1' }], resumeAfter: null },
    }
    const r = validateOpState(validOpState)
    expect(r.ok).toBe(false)
    // Swapping in an element that also carries toolUseId should flip this to passing, corroborating
    // that the failure above really was the missing toolUseId
    const fixed = {
      ...validOpState,
      phase: {
        kind: 'deferred',
        jobs: [{ jobId: 'j1', toolUseId: 'tu1', callSeq: 7 }],
        resumeAfter: null,
      },
    }
    expect(validateOpState(fixed).ok).toBe(true)
    const badCallSeq = {
      ...fixed,
      phase: { ...fixed.phase, jobs: [{ jobId: 'j1', toolUseId: 'tu1', callSeq: 0 }] },
    }
    expect(validateOpState(badCallSeq).ok).toBe(false)
  })

  it('C7: SessionStart with presetId/resolvedPresetHash/platform is valid', () => {
    const r = validateEvent({
      ...base,
      type: 'session/start',
      data: {
        key: 'k',
        resolvedProfileHash: null,
        preset: null,
        agnesVersion: '0.0.0',
        presetId: 'p1',
        resolvedPresetHash: 'h1',
        platform: { os: 'darwin', arch: 'arm64', shell: 'zsh' },
      },
    })
    expect(r.ok).toBe(true)
  })

  // The draft version dropped EventEnvelope.ts's format:'date-time' constraint, and all three
  // timestamp values below measured as VALID — a declared constraint that could never fail.
  // gen/ts/session-v1.ts now registers a real date-time checker (an RFC 3339 regex plus Date.parse),
  // and these cases verify it through validateEvent(), the public entry point for two-stage
  // validation.
  it('C-format: EventEnvelope.ts enforces the declared date-time format', () => {
    const withTs = (ts: unknown) =>
      validateEvent({ ...base, ts, type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }] } })
    const valid = withTs('2026-09-08T00:00:00Z')
    expect(valid.ok).toBe(true)
    const notADate = withTs('not-a-date')
    expect(notADate.ok).toBe(false)
    // Classified as PATTERN: a format violation and a pattern violation both mean "the string's
    // content has the wrong shape", so they reuse one code rather than adding a new ValidationError
    // code member just for format (see the classify() comment in src/validate.ts).
    if (!notADate.ok) expect(notADate.errors[0]).toMatchObject({ code: 'PATTERN', key: 'ts' })
    const empty = withTs('')
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.errors[0]).toMatchObject({ code: 'PATTERN', key: 'ts' })
  })

  // EventEnvelope.type is `type:"string"` + `maxLength:128` + `anyOf:[enum, pattern]`. The generator
  // once dropped the outer maxLength entirely on a string's anyOf branch, so a 208-character type
  // string matching the extension namespace pattern
  // (`^x\/(?:(?:core|agnes)\/[a-z0-9-]+|...)$`) got through both validation stages: real ajv judged
  // it INVALID while validateEvent() judged it VALID. This is the original instance, verified end to
  // end through the public validateEvent() entry point.
  it('rejects an extension event type that matches the namespace pattern but exceeds maxLength:128 (ajv-caught Critical)', () => {
    const type = `x/agnes/${'a'.repeat(200)}` // 208 chars: matches the pattern, exceeds maxLength:128
    expect(type.length).toBe(208)
    const r = validateEvent({ ...base, type, data: {} })
    expect(r.ok).toBe(false)
    // A short type of the same shape (same pattern, within the limit) must still be valid, proving
    // the failure really is about length and that the pattern has not regressed alongside it.
    expect(validateEvent({ ...base, type: 'x/agnes/foo', data: {} }).ok).toBe(true)
  })

  // For an event type that has a $def, smuggling `seams` into data must be rejected by the second
  // stage — a real boundary found during review. The envelope stage waves `data` through as
  // JsonValue (seams is just another string key and JsonValue's dictionary branch accepts it), so it
  // cannot catch this. Only validateEvent's second stage, which looks up the x-agnes-data table and
  // validates data against the concrete $def (here UserMessage, additionalProperties:false), can.
  it('rejects `seams` smuggled inside data for a type with an I1 $def (second stage only)', () => {
    const withSeamsInData = {
      ...base,
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'hi' }], seams: {} },
    }
    // The first stage (the envelope itself) waves data through on its own — data is JsonValue, and
    // its dictionary branch accepts any key.
    const envelopeOnly = validateEvent({ ...base, type: 'x/agnes/whatever', data: { seams: {} } })
    expect(envelopeOnly.ok).toBe(true)
    // But for a type that declares a $def, the second stage validates data against that $def
    // (additionalProperties:false), and seams is not among UserMessage's properties, so it must be
    // rejected.
    const r = validateEvent(withSeamsInData)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]).toMatchObject({ code: 'UNKNOWN_KEY', key: 'seams' })
  })

  // This assertion used to check only one direction, `DATA_DEFS ⊆ x-agnes-data`. Adding
  // `"plan.items": "Actor"` to `x-agnes-data` without touching DATA_DEFS left all 13 cases green, and
  // that event type would then pass envelope validation only (`if (!def) return env` in validate.ts),
  // with data waved through as an arbitrary JsonValue. The other direction — deleting a DATA_DEFS
  // entry — already went red because the fixtures caught it, so the gap was precisely on the "add"
  // side. Now a two-way toEqual, following the same coverage guard pattern used in
  // test/ajv-parity.test.ts.
  it('DATA_DEFS covers exactly schema/session-v1.json x-agnes-data (both directions)', () => {
    const schema = JSON.parse(
      readFileSync(new URL('../schema/session-v1.json', import.meta.url), 'utf8'),
    ) as {
      'x-agnes-data': Record<string, string>
    }
    expect(Object.keys(DATA_DEFS).sort()).toEqual(Object.keys(schema['x-agnes-data']).sort())
  })
})

describe('validation refusal descriptions', () => {
  const field: ValidationError = {
    path: '/data/durationMs',
    message: 'Expected nonnegative integer',
    code: 'RANGE',
  }
  it.each([
    [[field], '/data/durationMs Expected nonnegative integer'],
    [
      [{ ...field, path: '/data', key: 'effectId', code: 'MISSING' }],
      '/data/effectId Expected nonnegative integer',
    ],
    [[{ ...field, path: '' }], 'Expected nonnegative integer'],
    [[field, field, field], '/data/durationMs Expected nonnegative integer (+2 more)'],
    [[], 'invalid'],
  ] as [ValidationError[], string][])(
    'describes field, missing, root and multiple failures (%j)',
    (errors, expected) => {
      expect(describeValidationErrors(errors)).toBe(expected)
    },
  )
  it('names the invalid field inside root and nested unions without echoing values', async () => {
    const { Type } = await import('@sinclair/typebox')
    const { validateAgainst } = await import('@agnes/protocol-validation')
    const { validateMethod } = await import('../src/index.js')
    const root = validateMethod('_agnes/v1/session.list', 'params', { limit: 0 })
    expect(root.ok).toBe(false)
    if (!root.ok)
      expect(describeValidationErrors(root.errors)).toContain(
        '/limit Expected integer to be greater or equal to 1',
      )
    const nested = Type.Union([
      Type.Null(),
      Type.Object({
        payload: Type.Union([Type.String(), Type.Object({ limit: Type.Integer({ minimum: 1 }) })]),
      }),
    ])
    const result = validateAgainst(nested, { payload: { limit: 0, secret: 'private-canary' } }, '/request')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(describeValidationErrors(result.errors)).toBe(
        '/request/payload/limit Expected integer to be greater or equal to 1',
      )
      expect(describeValidationErrors(result.errors)).not.toContain('private-canary')
    }
    const tagged = Type.Union([
      Type.Object({ kind: Type.Literal('interval'), everyMs: Type.Integer({ minimum: 10 }) }),
      Type.Object({ kind: Type.Literal('cron'), expr: Type.String(), tz: Type.String({ maxLength: 4 }) }),
    ])
    const wrongZone = validateAgainst(tagged, { kind: 'cron', expr: '* * * * *', tz: 'private-canary' })
    expect(wrongZone.ok).toBe(false)
    if (!wrongZone.ok) {
      expect(wrongZone.errors[0]).toMatchObject({ path: '/tz', key: 'tz', code: 'RANGE' })
      expect(describeValidationErrors(wrongZone.errors)).not.toContain('everyMs')
      expect(describeValidationErrors(wrongZone.errors)).not.toContain('private-canary')
    }
  })
  it('bounds the displayed path without serializing extra rejected data', () => {
    const description = describeValidationErrors([
      { ...field, path: `/data/${'a'.repeat(500)}`, value: 'rejected-private-canary' } as ValidationError,
    ])
    expect(description.length).toBeLessThan(260)
    expect(description).toContain('…')
    expect(description).not.toContain('rejected-private-canary')
  })
})

// Compare the public result (including complete diagnostics), rather than pinning plan internals.
describe('generated validation reference plans', () => {
  it('matches the interpreter for generated roots, recursive values and adversarial mutations', async () => {
    const { Kind, Type } = await import('@sinclair/typebox')
    const { Value } = await import('@sinclair/typebox/value')
    const { validateAgainst, prepareValidationSchemas } = await import('@agnes/protocol-validation')
    const modules: Record<string, unknown>[] = await Promise.all([
      import('../gen/ts/session-v1.js'),
      import('../gen/ts/agnes-v1.js'),
      import('../gen/ts/app-server.js'),
      import('../gen/ts/package-admin.js'),
      import('../gen/ts/lockfile.js'),
      import('../gen/ts/extension-manifest.js'),
    ])
    const primitives: unknown[] = [
      null,
      undefined,
      true,
      false,
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      '',
      '\0',
      '\ud800',
      '2024-02-29T23:59:60Z',
      '2023-02-29T00:00:00Z',
      '2026-01-01T25:00:00Z',
      'x',
      [],
      {},
      () => 1,
      Symbol('x'),
      1n,
    ]
    const nested = { a: [1, { b: [null, 'text', { c: 2 }] }] }
    let accepted = 0
    let rejected = 0
    for (const module of modules)
      for (const raw of Object.values(module)) {
        if (raw === null || typeof raw !== 'object' || !(Kind in raw)) continue
        const schema = raw as import('@sinclair/typebox').TSchema
        const factory = Object.values(module).find(
          (value) => value && typeof value === 'object' && 'Import' in value,
        ) as { Import(key: string): import('@sinclair/typebox').TSchema } | undefined
        const interpreted =
          schema.$defs && typeof schema.$ref === 'string' && factory
            ? factory.Import(schema.$ref)
            : { ...schema }
        const cases = [...primitives, nested, { ...nested, a: [() => 1] }]
        try {
          cases.push(Value.Create(schema, Object.values(schema.$defs ?? {})))
        } catch {
          /* Formats and recursive required values have no default. */
        }
        for (const sample of [...cases]) {
          if (sample && typeof sample === 'object' && !Array.isArray(sample)) {
            cases.push({ ...sample, unknown: 1 })
            for (const key of Object.keys(sample).slice(0, 8)) {
              const missing = { ...sample } as Record<string, unknown>
              delete missing[key]
              cases.push(missing, { ...sample, [key]: undefined }, { ...sample, [key]: null })
            }
            cases.push(Object.assign(Object.create(sample), {}))
            const hidden = { ...sample }
            Object.defineProperty(hidden, 'hidden', { value: 1 })
            cases.push(hidden)
          }
        }
        for (const value of cases) {
          // A shallow root copy is deliberately unregistered, sharing exactly the same definitions.
          const expected = validateAgainst(interpreted, value, '/payload')
          expect(validateAgainst(schema, value, '/payload')).toEqual(expected)
          if (expected.ok) accepted++
          else rejected++
        }
      }
    console.info('VALIDATOR_DIFFERENTIAL', { accepted, rejected })
    expect(accepted).toBeGreaterThan(100)
    expect(rejected).toBeGreaterThan(1000)
    // Custom mutable schemas must not acquire a stale plan after their first check.
    const mutable = Type.String({ minLength: 1 })
    expect(validateAgainst(mutable, 'x').ok).toBe(true)
    mutable.minLength = 2
    expect(validateAgainst(mutable, 'x').ok).toBe(false)
    const dynamic = Type.Object({ n: Type.Number() })
    const requiredKeys = dynamic.required
    if (!requiredKeys) throw new Error('fixture requires a required-key array')
    let required = false
    requiredKeys.includes = () => required
    prepareValidationSchemas([dynamic])
    expect(validateAgainst(dynamic, {}).ok).toBe(true)
    required = true
    expect(validateAgainst(dynamic, {})).toEqual(validateAgainst({ ...dynamic }, {}))
    const composites: import('@sinclair/typebox').TSchema[] = [
      Type.Record(Type.String({ pattern: '^a' }), Type.Number(), { additionalProperties: false }),
      Type.Array(Type.Number(), { uniqueItems: true, contains: Type.Literal(1) }),
      Type.Tuple([Type.String(), Type.Number()]),
      Type.Intersect([
        Type.Object({ a: Type.Number() }),
        Type.Not(Type.Object({ forbidden: Type.Unknown() })),
      ]),
    ]
    prepareValidationSchemas(composites)
    for (const schema of composites)
      for (const value of [...primitives, { a: 1 }, { a: 'bad' }, { b: 1 }, [1, 1], [1, 2], ['x', 1]])
        expect(validateAgainst(schema, value)).toEqual(validateAgainst({ ...schema }, value))
    const accessorSchema = Type.Object({ value: Type.Number() })
    prepareValidationSchemas([accessorSchema])
    const accessorValue = () => {
      let first = true
      return Object.defineProperty({}, 'value', {
        enumerable: true,
        get() {
          if (first) {
            first = false
            return 'invalid'
          }
          return 7
        },
      })
    }
    expect(validateAgainst(accessorSchema, accessorValue())).toEqual(
      validateAgainst({ ...accessorSchema }, accessorValue()),
    )
    const first = Type.Object({ kind: Type.Literal('a'), value: Type.String() }, { $id: 'collision' })
    const second = Type.Object({ kind: Type.Literal('b'), value: Type.Number() }, { $id: 'collision' })
    const collision = Type.Object({ a: Type.Optional(first), b: second, c: Type.Ref('collision') })
    prepareValidationSchemas([collision])
    for (const c of [
      { kind: 'a', value: 'x' },
      { kind: 'b', value: 1 },
    ]) {
      const value = { b: { kind: 'b', value: 1 }, c }
      expect(validateAgainst(collision, value)).toEqual(validateAgainst({ ...collision }, value))
    }
    const recursive = Type.Recursive((This) => Type.Union([Type.Null(), Type.Array(This)]))
    prepareValidationSchemas([recursive])
    for (const value of [null, [null, [[null]]], [undefined], { a: null }])
      expect(validateAgainst(recursive, value)).toEqual(validateAgainst({ ...recursive }, value))
  })

  it('plans package-admin schemas with identical verdicts for each structural type and format field', async () => {
    const { validateAgainst } = await import('@agnes/protocol-validation')
    const P = await import('../gen/ts/package-admin.js')
    const integrity = `sha256-${'a'.repeat(64)}`
    const provenance = {
      source: { type: 'git', ref: 'git:https://example.invalid/repo#main' },
      integrity,
      signatureVerified: false,
      installedAt: '2026-01-01T00:00:00Z',
    }
    const cases: [import('@sinclair/typebox').TSchema, unknown][] = [
      // union + literal + pattern + git-source format
      [P.PackageSource, { type: 'local', ref: 'local:home/demo' }],
      [P.PackageSource, { type: 'git', ref: 'git:https://example.invalid/repo#main' }],
      [P.PackageSource, { type: 'git', ref: 'git:https://' }],
      [P.PackageSource, { type: 'git', ref: 'git:http://example.invalid/repo' }],
      [P.PackageSource, { type: 'local', ref: 'local:elsewhere/demo' }],
      // object + ref + date-time format + optional
      [P.PackageProvenance, provenance],
      [P.PackageProvenance, { ...provenance, installedAt: 'not-a-date' }],
      [P.PackageProvenance, { ...provenance, source: { type: 'git', ref: 'git:https://' } }],
      [P.PackageProvenance, { ...provenance, integrity: 'bad' }],
      [P.PackageProvenance, { ...provenance, extra: 1 }],
      [P.PackageProvenance, { ...provenance, signatureVerified: undefined }],
      [
        P.PackageTrustDecision,
        { integrity, capabilityHash: 'b'.repeat(64), decidedAt: '2026-01-01T00:00:00Z' },
      ],
      [
        P.PackageTrustDecision,
        { integrity, capabilityHash: 'b'.repeat(64), decidedAt: '2026-13-01T00:00:00Z' },
      ],
      // array + uniqueItems + recursive json value
      [P.JsonValue, [null, { a: [1, 'x', true] }]],
      [P.JsonValue, [undefined]],
      [P.JsonValue, { a: () => 1 }],
      [P.HookEvent, 'session_start'],
      [P.HookEvent, 'nope'],
      // plugin-docs-url format
      [P.PluginMetadataLocale, { docsUrl: 'https://example.invalid/docs' }],
      [P.PluginMetadataLocale, { docsUrl: ' javascript:alert(1)' }],
    ]
    let accepted = 0
    let rejected = 0
    for (const [schema, value] of cases) {
      const actual = validateAgainst(schema, value, '/payload')
      expect(actual).toEqual(validateAgainst({ ...schema }, value, '/payload'))
      if (actual.ok) accepted++
      else rejected++
    }
    expect(accepted).toBeGreaterThan(4)
    expect(rejected).toBeGreaterThan(10)
  })

  it('checks uniqueItems with the same hash identity as TypeBox for every value kind', async () => {
    const { Type } = await import('@sinclair/typebox')
    const { Hash } = await import('@sinclair/typebox/value')
    const { validateAgainst, prepareValidationSchemas } = await import('@agnes/protocol-validation')
    const Unique = Type.Module({ Items: Type.Array(Type.Unknown(), { uniqueItems: true }) }).Import('Items')
    prepareValidationSchemas([Unique])
    const sym = Symbol('s')
    const nested = (n: number): unknown => (n === 0 ? 'leaf' : { k: [n, nested(n - 1)] })
    const values: unknown[] = [
      0,
      -0,
      1,
      255,
      256,
      65535,
      1.5,
      NaN,
      Infinity,
      -Infinity,
      2 ** 53,
      1e21,
      '',
      '\0',
      'a',
      'ab',
      'a\0',
      'ÿ',
      'Ā',
      '￿',
      '\ud800',
      'é',
      '日本',
      'x'.repeat(40),
      true,
      false,
      null,
      undefined,
      1n,
      2n,
      -1n,
      2n ** 63n - 1n,
      [],
      [undefined],
      [null],
      [[]],
      [0],
      [-0],
      ['a', 'b'],
      ['ab'],
      ['a', ['b']],
      {},
      { a: 1 },
      { a: undefined },
      { a: 1, b: 2 },
      { b: 2, a: 1 },
      { a: [1] },
      { a: { b: 1 } },
      { '': 0 },
      { Ā: 1 },
      { 1: 'x', 10: 'y', 2: 'z' },
      new Date(0),
      new Date(1),
      new Date(NaN),
      new Uint8Array([1, 2]),
      new Uint8Array([1, 3]),
      sym,
      Symbol(),
      Symbol('s'),
      nested(3),
      nested(3),
    ]
    let duplicates = 0
    for (const a of values)
      for (const b of values) {
        const same = Hash(a) === Hash(b)
        const actual = validateAgainst(Unique, [a, b])
        expect(actual.ok).toBe(!same)
        expect(actual).toEqual(validateAgainst({ ...Unique }, [a, b]))
        if (same) duplicates++
      }
    expect(duplicates).toBeGreaterThan(values.length)
    // Unhashable elements fail exactly as the interpreter does.
    const unhashable = [() => 1]
    expect(() => validateAgainst({ ...Unique }, unhashable)).toThrow()
    expect(() => validateAgainst(Unique, unhashable)).toThrow()
    const Limited = Type.Module({
      Items: Type.Array(Type.Number(), { uniqueItems: true, maxItems: 2 }),
    }).Import('Items')
    prepareValidationSchemas([Limited])
    for (const value of [[1, 2], [1, 1], [1, 'x'], [1, 2, 3], 'no', [[1]]])
      expect(validateAgainst(Limited, value)).toEqual(validateAgainst({ ...Limited }, value))
  })

  it('preserves live policies, formats, property presence and unresolved-reference errors', async () => {
    const { Type, FormatRegistry } = await import('@sinclair/typebox')
    const { TypeSystemPolicy } = await import('@sinclair/typebox/system')
    const { validateAgainst, prepareValidationSchemas } = await import('@agnes/protocol-validation')
    const schema = Type.Object(
      {
        required: Type.Unknown(),
        optional: Type.Optional(Type.Number()),
        formatted: Type.Optional(Type.String({ format: 'perf-differential' })),
        values: Type.Optional(Type.Array(Type.Number())),
        voidValue: Type.Optional(Type.Void()),
      },
      { additionalProperties: false },
    )
    prepareValidationSchemas([schema])
    const saved = {
      exact: TypeSystemPolicy.ExactOptionalPropertyTypes,
      arrays: TypeSystemPolicy.AllowArrayObject,
      nan: TypeSystemPolicy.AllowNaN,
      void: TypeSystemPolicy.AllowNullVoid,
    }
    try {
      for (const exact of [false, true])
        for (const arrays of [false, true])
          for (const nan of [false, true])
            for (const allowNull of [false, true]) {
              TypeSystemPolicy.ExactOptionalPropertyTypes = exact
              TypeSystemPolicy.AllowArrayObject = arrays
              TypeSystemPolicy.AllowNaN = nan
              TypeSystemPolicy.AllowNullVoid = allowNull
              for (const format of [undefined, (value: string) => value === 'allowed', () => false]) {
                if (format) FormatRegistry.Set('perf-differential', format)
                else FormatRegistry.Delete('perf-differential')
                const inherited = Object.create({ required: null })
                const samples = [
                  {},
                  { required: undefined },
                  { required: 1, optional: undefined },
                  { required: 1, optional: NaN },
                  { required: null, formatted: 'allowed' },
                  { required: null, formatted: 'denied' },
                  { required: null, values: [Infinity] },
                  { required: null, voidValue: null },
                  inherited,
                  [],
                ]
                for (const value of samples)
                  expect(validateAgainst(schema, value)).toEqual(validateAgainst({ ...schema }, value))
              }
            }
      const scalar = Type.String({ format: 'perf-differential' })
      prepareValidationSchemas([scalar])
      // JavaScript format providers can return truthy values despite the boolean annotation.
      Reflect.apply(FormatRegistry.Set, undefined, ['perf-differential', () => 1])
      expect(validateAgainst(scalar, 'allowed')).toEqual(validateAgainst({ ...scalar }, 'allowed'))
      for (const field of ['b', '$defs']) {
        const conditional = Type.Object({
          a: Type.Optional(Type.Number({ $id: 'inline-number' })),
          [field]: Type.Ref('inline-number'),
        })
        prepareValidationSchemas([conditional])
        expect(() => validateAgainst(conditional, { [field]: 1 })).toThrow(
          "Unable to dereference schema with $id 'inline-number'",
        )
        expect(validateAgainst(conditional, { a: 1, [field]: 2 }).ok).toBe(true)
      }
      const missing = Type.Union([Type.String(), Type.Ref('not-registered')])
      prepareValidationSchemas([missing])
      expect(validateAgainst(missing, 'short circuit').ok).toBe(true)
      expect(() => validateAgainst(missing, 0)).toThrow(
        "Unable to dereference schema with $id 'not-registered'",
      )
    } finally {
      TypeSystemPolicy.ExactOptionalPropertyTypes = saved.exact
      TypeSystemPolicy.AllowArrayObject = saved.arrays
      TypeSystemPolicy.AllowNaN = saved.nan
      TypeSystemPolicy.AllowNullVoid = saved.void
      FormatRegistry.Delete('perf-differential')
    }
  })
})
