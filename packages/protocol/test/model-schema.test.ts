import { readFileSync } from 'node:fs'
import { Value } from '@sinclair/typebox/value'
import { describe, expect, it } from 'vitest'
import * as M from '../gen/ts/model.js'
import { AI_ERROR_CODES, SLOT_NAMES, validateAgainst } from '../src/index.js'

const doc = JSON.parse(readFileSync(new URL('../schema/model.json', import.meta.url), 'utf8')) as {
  $defs: Record<string, unknown>
}

describe('model.json', () => {
  it('freezes 11 error codes and 7 slots', () => {
    expect(AI_ERROR_CODES).toEqual([
      'AUTH',
      'RATE_LIMIT',
      'QUOTA',
      'OVERFLOW',
      'TIMEOUT',
      'NO_MODEL',
      'NO_ADAPTER',
      'FORMAT',
      'TRANSPORT',
      'CONTRACT_MISMATCH',
      'ABORTED',
    ])
    expect(SLOT_NAMES).toEqual(['primary', 'escalation', 'fast', 'compaction', 'verifier', 'image', 'video'])
  })

  // The two constants are hand-written `as const` tuples while the enums they mirror live in the
  // schema. Nothing in the type system forces the two to agree on membership: `satisfies readonly
  // AiErrorCode[]` rejects an element that is not a member, but says nothing about a member the tuple
  // forgot. Dropping an entry from either tuple would therefore stay green everywhere except here,
  // and every caller iterating the tuple would silently skip that code or slot. Compared against the
  // schema itself, in order, so a reordering is caught too.
  it('the two constants are exactly the schema enums, in schema order', () => {
    const enumOf = (name: string): unknown[] => (doc.$defs[name] as { enum: unknown[] }).enum
    expect(AI_ERROR_CODES).toEqual(enumOf('AiErrorCode'))
    expect(SLOT_NAMES).toEqual(enumOf('SlotName'))
    for (const code of AI_ERROR_CODES) expect(Value.Check(M.AiErrorCode, code), code).toBe(true)
    for (const slot of SLOT_NAMES) expect(Value.Check(M.SlotName, slot), slot).toBe(true)
  })

  it('accepts a minimal RequestBody and rejects an extra key', () => {
    const body = {
      kind: 'inference',
      sessionKey: 'agnes:t:a:cli:dm:x',
      slot: 'primary',
      route: 'agnes-gateway',
      model: 'agnes-flash',
      contractId: null,
      derivedHash: 'a'.repeat(64),
      system: 'You are helpful.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [],
    }
    expect(Value.Check(M.RequestBody, body)).toBe(true)
    const r = validateAgainst(M.RequestBody, { ...body, seams: {} })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.errors[0]?.code).toBe('UNKNOWN_KEY')
  })

  it('rejects a derivedHash that is not 64 lowercase hex digits', () => {
    const body = {
      kind: 'inference',
      sessionKey: 'k',
      slot: 'primary',
      route: 'r',
      model: 'm',
      contractId: null,
      derivedHash: 'A'.repeat(64),
      system: '',
      messages: [],
      tools: [],
    }
    expect(Value.Check(M.RequestBody, body)).toBe(false)
    expect(Value.Check(M.RequestBody, { ...body, derivedHash: 'a'.repeat(63) })).toBe(false)
    expect(Value.Check(M.RequestBody, { ...body, derivedHash: 'a'.repeat(64) })).toBe(true)
  })

  it('InferenceEvent union covers the seven variants', () => {
    const stamp = {
      prompt_prefix_hash: null,
      tool_schema_hash: 'b'.repeat(64),
      parser_version: '1',
      contract_id: null,
      model: { route: 'r', id: 'm' },
      derived_hash: 'a'.repeat(64),
      sent_hash: 'a'.repeat(64),
      transforms: [],
    }
    for (const ev of [
      { type: 'sent', stamp },
      { type: 'text_delta', delta: 'x' },
      { type: 'thinking_delta', delta: 'x' },
      { type: 'toolcall_delta', delta: '{' },
      {
        type: 'toolcall_end',
        call: { toolUseId: 't1', name: 'read', args: { path: 'a' }, ordinal: 0 },
        via: 'native',
      },
      { type: 'deviation', rule: 'unparsed', sampleHash: 'c'.repeat(64) },
      {
        type: 'usage',
        tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        creditSource: 'estimated',
      },
      { type: 'done', reason: 'stop' },
      {
        type: 'error',
        reason: 'error',
        code: 'TRANSPORT',
        message: 'boom',
        retryable: true,
        retryAfterMs: 500,
      },
    ])
      expect(Value.Check(M.InferenceEvent, ev), JSON.stringify(ev)).toBe(true)
    expect(
      Value.Check(M.InferenceEvent, {
        type: 'error',
        reason: 'error',
        code: 'NOPE',
        message: '',
        retryable: false,
      }),
    ).toBe(false)
  })

  // `via` distinguishes a call the wire protocol carried natively from one recovered by a decode
  // rule, so it is required and closed to the decode-rule set plus 'native'.
  it('toolcall_end requires a via drawn from native plus the decode rules', () => {
    const call = { toolUseId: 't1', name: 'read', args: {}, ordinal: 0 }
    expect(Value.Check(M.InferenceEvent, { type: 'toolcall_end', call })).toBe(false)
    expect(Value.Check(M.InferenceEvent, { type: 'toolcall_end', call, via: 'think_tag' })).toBe(true)
    expect(Value.Check(M.InferenceEvent, { type: 'toolcall_end', call, via: 'made_up' })).toBe(false)
  })

  it('CountResult is either a counted result or the unsupported marker, never both', () => {
    expect(Value.Check(M.CountResult, { source: 'unsupported' })).toBe(true)
    expect(Value.Check(M.CountResult, { tokens: 10, source: 'provider', boundHash: 'a'.repeat(64) })).toBe(
      true,
    )
    // 'unsupported' carries no counts, and a counted result may not claim that source
    expect(Value.Check(M.CountResult, { tokens: 10, source: 'unsupported', boundHash: 'a'.repeat(64) })).toBe(
      false,
    )
    expect(Value.Check(M.CountResult, { tokens: 10, source: 'provider' })).toBe(false)
  })

  it('RouteTable requires primary and validates fallbacks', () => {
    expect(
      Value.Check(M.RouteTable, {
        primary: { route: 'r', model: 'm', fallbacks: [{ route: 'r2', model: 'm2' }] },
      }),
    ).toBe(true)
    expect(Value.Check(M.RouteTable, { escalation: { route: 'r', model: 'm' } })).toBe(false)
    expect(
      Value.Check(M.RouteTable, { primary: { route: 'r', model: 'm', fallbacks: [{ route: 'r2' }] } }),
    ).toBe(false)
  })

  // RouteDecl.route names a route in Profile configuration and appears in RequestBody.route; the
  // pattern keeps it to a lowercase slug so the two sides cannot disagree over case.
  it('RouteDecl constrains the route slug and the credential reference scheme', () => {
    const base = { route: 'agnes-gateway', api: 'openai-completions', baseUrl: 'https://gw.invalid' }
    expect(Value.Check(M.RouteDecl, base)).toBe(true)
    expect(Value.Check(M.RouteDecl, { ...base, route: 'Agnes-Gateway' })).toBe(false)
    expect(Value.Check(M.RouteDecl, { ...base, route: '-leading-dash' })).toBe(false)
    expect(Value.Check(M.RouteDecl, { ...base, credentialRef: 'secret://agnes/gateway' })).toBe(true)
    expect(Value.Check(M.RouteDecl, { ...base, credentialRef: 'env://AGNES_KEY' })).toBe(false)
  })
})
