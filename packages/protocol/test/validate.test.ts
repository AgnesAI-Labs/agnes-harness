import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { toRpcError, validateEvent, validateOpState } from '../src/index.js'
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
    if (!r.ok) expect(r.errors[0]).toMatchObject({ code: 'MISSING', key: 'trust' })
  })
  it('validates data by type in stage two', () => {
    const r = validateEvent({
      ...base,
      type: 'tool/result',
      data: { toolUseId: 't1', content: [], isError: false, authz: { decisionId: 'n/a' } },
    })
    expect(r.ok).toBe(false) // missing enforcement
    if (!r.ok) expect(r.errors[0]).toMatchObject({ code: 'MISSING', key: 'enforcement', path: '/data' })
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
