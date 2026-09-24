import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { EVENT_TYPES, EXT_EVENT_PATTERN_SOURCE, ULID_PATTERN } from '../src/index.js'

const doc = JSON.parse(readFileSync(new URL('../schema/session-v1.json', import.meta.url), 'utf8'))
const agnes = JSON.parse(readFileSync(new URL('../schema/agnes-v1.json', import.meta.url), 'utf8'))

describe('session-v1.json', () => {
  it('enum of type equals EVENT_TYPES and pattern equals EXT_EVENT_PATTERN', () => {
    const anyOf = doc.$defs.EventEnvelope.properties.type.anyOf
    expect(anyOf[0].enum).toEqual([...EVENT_TYPES])
    expect(anyOf[1].pattern).toBe(EXT_EVENT_PATTERN_SOURCE)
  })
  // ULID_PATTERN was the one duplicated constant in constants.ts that nothing pinned. Its two
  // siblings (EVENT_TYPES / EXT_EVENT_PATTERN_SOURCE) are bound character for character to the schema
  // by the case above, while it was not — boundary.test.ts only asserts that it exists on the export
  // surface. Two guarded and a third unguarded in the same file is an omission, not a design choice.
  it('EventEnvelope.id pattern equals ULID_PATTERN', () => {
    expect(doc.$defs.EventEnvelope.properties.id.pattern).toBe(ULID_PATTERN.source)
  })

  it('x-agnes-data maps only known types to existing $defs', () => {
    for (const [type, def] of Object.entries(doc['x-agnes-data'] as Record<string, string>)) {
      expect(EVENT_TYPES).toContain(type)
      expect(doc.$defs[def], `$defs.${def}`).toBeDefined()
    }
  })

  it('keeps the public approval grant record identical to the durable session grant', () => {
    expect(agnes.$defs.ApprovalGrantRecord).toEqual(doc.$defs.ApprovalGrant)
  })

  // ToolCall gains an optional depth (sub-call re-entry depth). No general JSON Schema instance
  // validator is available at this layer — @sinclair/typebox's Value.Check only understands a TSchema
  // built by Type.*, not this hand-written draft 2020-12 plain JSON document — so this follows the
  // file's existing approach and asserts on what the schema structure itself expresses as legal or
  // illegal, rather than running a real instance validation.
  it('C3: ToolCall.depth is an optional non-negative integer', () => {
    const toolCall = doc.$defs.ToolCall
    expect(toolCall.properties.depth).toEqual({ type: 'integer', minimum: 0 })
    expect(toolCall.required).not.toContain('depth')
    // depth: 1 is legal: type integer and >= minimum
    expect(Number.isInteger(1) && 1 >= toolCall.properties.depth.minimum).toBe(true)
  })

  // TurnStart.continues gains an optional requestId, pairing a resumed turn with its approval
  // decision.
  it('C3: TurnStart.continues.requestId is an optional bounded string', () => {
    const continues = doc.$defs.TurnStart.properties.continues
    expect(continues.properties.requestId).toEqual({ type: 'string', maxLength: 128 })
    expect(continues.required).not.toContain('requestId')
    expect(continues.required).toEqual(['turn', 'step'])
  })

  // SessionStart gains three optional fields recording what the host actually holds at createSession
  // time; required is unchanged, still the same four entries.
  it('C7: SessionStart carries three optional host-provided fields, required unchanged', () => {
    const sessionStart = doc.$defs.SessionStart
    expect(sessionStart.required).toEqual(['key', 'resolvedProfileHash', 'preset', 'agnesVersion'])
    expect(sessionStart.properties.presetId).toEqual({ type: ['string', 'null'], maxLength: 128 })
    expect(sessionStart.properties.resolvedPresetHash).toEqual({ type: ['string', 'null'], maxLength: 128 })
    expect(sessionStart.properties.platform).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        os: { type: 'string', maxLength: 32 },
        arch: { type: 'string', maxLength: 32 },
        shell: { type: 'string', maxLength: 32 },
      },
    })
    for (const key of ['presetId', 'resolvedPresetHash', 'platform'])
      expect(sessionStart.required).not.toContain(key)
  })

  // OpState's deferred-phase jobs changed from an array of strings to an array of
  // { jobId, toolUseId } objects; an element missing toolUseId must be illegal, since toolUseId is
  // required and the object is closed.
  it('C5: OpState deferred phase jobs are {jobId, toolUseId} objects, missing toolUseId is invalid', () => {
    type Branch = { properties: { kind: { const: string }; jobs?: { items: Record<string, unknown> } } }
    const phaseBranches = doc.$defs.OpState.oneOf[1].properties.phase.oneOf as Branch[]
    const deferred = phaseBranches.find((b) => b.properties.kind.const === 'deferred')
    if (!deferred?.properties.jobs) throw new Error('deferred.jobs branch not found in schema')
    const jobsItems = deferred.properties.jobs.items as {
      type: string
      additionalProperties: boolean
      required: string[]
      properties: Record<string, unknown>
    }
    expect(jobsItems).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['jobId', 'toolUseId'],
      properties: {
        jobId: { type: 'string', maxLength: 128 },
        toolUseId: { type: 'string', maxLength: 128 },
        callSeq: { type: 'integer', minimum: 1 },
      },
    })
    // { jobId: 'j1' } is missing toolUseId: required unsatisfied plus additionalProperties:false
    // makes that instance illegal
    const illegalJob = { jobId: 'j1' }
    const missingRequired = jobsItems.required.some((k) => !(k in illegalJob))
    expect(missingRequired).toBe(true)
  })
})
