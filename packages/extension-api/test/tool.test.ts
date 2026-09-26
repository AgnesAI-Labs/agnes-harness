import { Type } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import {
  APPROVAL_SCOPE_PATTERN,
  checkResolvedToolCallPolicy,
  checkToolDef,
  checkToolMeta,
  defineTool,
  MAX_APPROVAL_SCOPES,
  resolveToolCallPolicy,
  TOOL_DESCRIPTION_MAX_LENGTH,
  TOOL_META_KEYS,
  TOOL_NAME_PATTERN,
  TOOL_PARAMETERS_MAX_BYTES,
  TOOL_PARAMETERS_MAX_DEPTH,
  TOOL_POLICY_VERSION_PATTERN,
} from '../src/index.js'

const fullMeta = {
  isReadOnly: true,
  isDestructive: false,
  isConcurrencySafe: true,
  isOpenWorld: false,
  replay: 'safe',
  costHint: undefined,
  deferLoading: undefined,
  requiresApproval: undefined,
} as const

describe('checkToolMeta (every one of the eight keys must be written out)', () => {
  it('accepts explicit undefined for the last three keys', () => {
    expect(checkToolMeta(fullMeta)).toEqual({ ok: true })
    expect(TOOL_META_KEYS).toEqual([
      'isReadOnly',
      'isDestructive',
      'isConcurrencySafe',
      'isOpenWorld',
      'replay',
      'costHint',
      'deferLoading',
      'requiresApproval',
    ])
  })
  it('rejects a missing key even if optional', () => {
    const { deferLoading: _d, ...noDefer } = fullMeta
    const r = checkToolMeta(noDefer)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.problems).toEqual(['missing key: deferLoading'])
  })
  it('rejects wrong value domains', () => {
    const r = checkToolMeta({
      ...fullMeta,
      replay: 'maybe',
      isReadOnly: 'yes',
      requiresApproval: 'sometimes',
    })
    expect(r.ok).toBe(false)
    if (!r.ok)
      expect(r.problems).toEqual([
        'isReadOnly: expected boolean',
        'replay: expected safe | never | idempotent',
        'requiresApproval: expected never | destructive | always | undefined',
      ])
  })
  it('rejects costHint shapes the type would not allow', () => {
    // costHint feeds the budget estimate and this is the only runtime gate it passes through.
    // The shape is { credits?: number; wallMs?: number } | undefined, so arrays, wrong value
    // types and misspelled keys all have to be caught here.
    const bad = (costHint: unknown) => {
      const r = checkToolMeta({ ...fullMeta, costHint })
      return r.ok ? [] : r.problems
    }
    expect(bad([])).toEqual(['costHint: expected { credits?: number; wallMs?: number } | undefined'])
    expect(bad(null)).toEqual(['costHint: expected { credits?: number; wallMs?: number } | undefined'])
    expect(bad(3)).toEqual(['costHint: expected { credits?: number; wallMs?: number } | undefined'])
    expect(bad({ credits: 'lots' })).toEqual(['costHint.credits: expected finite number | undefined'])
    expect(bad({ wallMs: Number.NaN })).toEqual(['costHint.wallMs: expected finite number | undefined'])
    expect(bad({ credit: 5 })).toEqual(['costHint: unknown key credit'])
    // Legal shapes still pass: either key may be absent or explicitly undefined.
    expect(checkToolMeta({ ...fullMeta, costHint: {} })).toEqual({ ok: true })
    expect(checkToolMeta({ ...fullMeta, costHint: { credits: 1.5, wallMs: 200 } })).toEqual({ ok: true })
    expect(checkToolMeta({ ...fullMeta, costHint: { credits: undefined } })).toEqual({ ok: true })
  })
  it('rejects non-objects', () => {
    expect(checkToolMeta(null).ok).toBe(false)
    expect(checkToolMeta('x').ok).toBe(false)
  })
  it('preserves legacy static metadata compatibility even for contradictory safety flags', () => {
    expect(checkToolMeta({ ...fullMeta, isDestructive: true })).toEqual({ ok: true })
  })
})

describe('checkResolvedToolCallPolicy', () => {
  const policy = {
    isReadOnly: false,
    isDestructive: true,
    replay: 'never',
    requiresApproval: 'destructive',
    approvalScopes: ['cua:click:background'],
  } as const

  it('accepts the exact dynamic safety-policy shape', () => {
    expect(checkResolvedToolCallPolicy(policy)).toEqual({ ok: true })
    expect(APPROVAL_SCOPE_PATTERN.test('cua:click:background')).toBe(true)
    expect(APPROVAL_SCOPE_PATTERN.test(`A${'x'.repeat(63)}`)).toBe(true)
    expect(APPROVAL_SCOPE_PATTERN.test(`A${'x'.repeat(64)}`)).toBe(false)
    expect(APPROVAL_SCOPE_PATTERN.test('1cua:click')).toBe(false)
  })

  it('rejects invalid scopes, duplicate scopes, contradictory flags, and unknown privilege fields', () => {
    const r = checkResolvedToolCallPolicy({
      ...policy,
      isReadOnly: true,
      approvalScopes: ['cua:click:background', 'bad scope', 'cua:click:background'],
      executionDomain: 'host-computer-use',
    })
    expect(r.ok).toBe(false)
    if (!r.ok)
      expect(r.problems).toEqual([
        'isReadOnly/isDestructive: cannot both be true',
        'approvalScopes[1]: must be a restricted identifier',
        'approvalScopes[2]: duplicate scope cua:click:background',
        'unknown key: executionDomain',
      ])
  })

  it('rejects incomplete and wrong-domain policies', () => {
    const r = checkResolvedToolCallPolicy({
      isReadOnly: false,
      isDestructive: false,
      replay: 'sometimes',
      requiresApproval: undefined,
      approvalScopes: 'cua:capture',
    })
    expect(r.ok).toBe(false)
    if (!r.ok)
      expect(r.problems).toEqual([
        'replay: expected safe | never | idempotent',
        'requiresApproval: expected never | destructive | always',
        'approvalScopes: expected array',
      ])
  })
  it('enforces the bounded approval-scope collection', () => {
    const r = checkResolvedToolCallPolicy({
      ...policy,
      approvalScopes: Array.from({ length: MAX_APPROVAL_SCOPES + 1 }, (_, i) => `cua:item:${i}`),
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.problems).toEqual(['approvalScopes: expected at most 16 items'])
  })
})

describe('checkToolDef', () => {
  const def = defineTool({
    name: 'sales_query',
    description: 'Query sales',
    parameters: Type.Object({ q: Type.String() }, { additionalProperties: false }),
    meta: fullMeta,
    execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
  })
  it('accepts a well-formed def and enforces prefix when given', () => {
    expect(checkToolDef(def)).toEqual({ ok: true })
    expect(checkToolDef(def, { prefix: 'sales_' })).toEqual({ ok: true })
    const r = checkToolDef(def, { prefix: 'erp_' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.problems).toEqual(["name: must start with prefix 'erp_'"])
  })
  it('rejects bad names, missing execute, bad meta', () => {
    expect(TOOL_NAME_PATTERN.test('9bad')).toBe(false)
    const r = checkToolDef({
      ...def,
      name: 'has-dash',
      execute: 'nope',
      meta: { ...fullMeta, replay: 'x' },
    })
    expect(r.ok).toBe(false)
    if (!r.ok)
      expect(r.problems).toEqual([
        'name: must match ^[A-Za-z_][A-Za-z0-9_]{0,63}$',
        'execute: expected function',
        'meta.replay: expected safe | never | idempotent',
      ])
  })
  it('defineTool is identity', () => {
    expect(defineTool(def)).toBe(def)
  })
  it('accepts a synchronous classifier with an explicit stable policy version', () => {
    const dynamic = defineTool({
      ...def,
      policyVersion: 'computer-use-v1',
      classify: (args) => ({
        isReadOnly: args.q === 'read',
        isDestructive: args.q !== 'read',
        replay: args.q === 'read' ? 'safe' : 'never',
        requiresApproval: args.q === 'read' ? 'never' : 'destructive',
        approvalScopes: args.q === 'read' ? [] : ['cua:click:background'],
      }),
    })
    expect(TOOL_POLICY_VERSION_PATTERN.test(dynamic.policyVersion as string)).toBe(true)
    expect(checkToolDef(dynamic)).toEqual({ ok: true })
    expect(dynamic.classify?.({ q: 'read' })).toEqual({
      isReadOnly: true,
      isDestructive: false,
      replay: 'safe',
      requiresApproval: 'never',
      approvalScopes: [],
    })
    expect(resolveToolCallPolicy(dynamic, { q: 'write' })).toEqual({
      isReadOnly: false,
      isDestructive: true,
      replay: 'never',
      requiresApproval: 'destructive',
      approvalScopes: ['cua:click:background'],
    })
  })
  it('maps legacy static metadata to an equivalent resolved policy with no new scopes', () => {
    expect(resolveToolCallPolicy(def, { q: 'read' })).toEqual({
      isReadOnly: true,
      isDestructive: false,
      replay: 'safe',
      requiresApproval: 'never',
      approvalScopes: [],
    })
  })
  it('rejects classifier/version mismatches, invalid versions, and declared async classifiers', () => {
    const noVersion = checkToolDef({ ...def, classify: () => ({}) })
    expect(noVersion.ok).toBe(false)
    if (!noVersion.ok)
      expect(noVersion.problems).toEqual(['policyVersion: required when classify is present'])

    const noClassifier = checkToolDef({ ...def, policyVersion: 'v1' })
    expect(noClassifier.ok).toBe(false)
    if (!noClassifier.ok)
      expect(noClassifier.problems).toEqual(['policyVersion: must be omitted when classify is absent'])

    const invalidVersion = checkToolDef({ ...def, policyVersion: 'bad version', classify: () => ({}) })
    expect(invalidVersion.ok).toBe(false)
    if (!invalidVersion.ok)
      expect(invalidVersion.problems).toEqual(['policyVersion: must be a restricted identifier'])

    const numericVersion = checkToolDef({ ...def, policyVersion: '1', classify: () => ({}) })
    expect(numericVersion.ok).toBe(false)
    if (!numericVersion.ok)
      expect(numericVersion.problems).toEqual(['policyVersion: must be a restricted identifier'])

    const asyncClassifier = checkToolDef({
      ...def,
      policyVersion: 'v1',
      classify: async () => ({
        isReadOnly: true,
        isDestructive: false,
        replay: 'safe',
        requiresApproval: 'never',
        approvalScopes: [],
      }),
    })
    expect(asyncClassifier.ok).toBe(false)
    if (!asyncClassifier.ok)
      expect(asyncClassifier.problems).toEqual(['classify: expected synchronous function, received Promise'])
  })
  it('fails closed for Promise and invalid runtime classifier output', () => {
    const promiseDef = {
      ...def,
      policyVersion: 'v1',
      classify: () => Promise.resolve({}),
    } as unknown as typeof def
    expect(() => resolveToolCallPolicy(promiseDef, { q: 'read' })).toThrow(
      'classify: expected synchronous function, received Promise',
    )

    const privilegedDef = {
      ...def,
      policyVersion: 'v1',
      classify: () => ({
        isReadOnly: true,
        isDestructive: false,
        replay: 'safe',
        requiresApproval: 'never',
        approvalScopes: [],
        transportPhase: 'not_sent',
      }),
    } as unknown as typeof def
    expect(() => resolveToolCallPolicy(privilegedDef, { q: 'read' })).toThrow(
      'classify: invalid resolved policy: unknown key: transportPhase',
    )
  })
})

describe('checkToolDef bounds on what a model is shown', () => {
  const base = {
    name: 'sales_query',
    description: 'Query sales',
    parameters: Type.Object({ q: Type.String() }, { additionalProperties: false }),
    meta: fullMeta,
    execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
  }
  const problems = (over: Record<string, unknown>): string[] => {
    const r = checkToolDef({ ...base, ...over })
    return r.ok ? [] : r.problems
  }
  /** A schema whose deepest value sits `depth` levels below the root (the root is depth 0). */
  const nested = (depth: number): Record<string, unknown> => {
    let value: unknown = 'leaf'
    for (let i = 0; i < depth; i++) value = { a: value }
    return value as Record<string, unknown>
  }
  /** `{"type":"object","description":"…"}` padded to exactly `bytes` UTF-8 bytes. */
  const sized = (bytes: number) => ({ type: 'object', description: 'x'.repeat(bytes - 34) })

  it('accepts a 4096-unit description and names the problem at 4097', () => {
    expect(problems({ description: 'd'.repeat(4096) })).toEqual([])
    expect(problems({ description: 'd'.repeat(4097) })).toEqual([
      'description: must be at most 4096 UTF-16 code units',
    ])
  })

  it('bounds the serialized parameter schema at 262144 bytes', () => {
    expect(new TextEncoder().encode(JSON.stringify(sized(262_145))).byteLength).toBe(262_145)
    expect(problems({ parameters: sized(262_144) })).toEqual([])
    expect(problems({ parameters: sized(262_145) })).toEqual([
      'parameters: serialized size must be at most 262144 bytes',
    ])
  })

  it('bounds parameter nesting at 32 with the root at depth 0', () => {
    expect(problems({ parameters: nested(32) })).toEqual([])
    expect(problems({ parameters: nested(33) })).toEqual(['parameters: nesting must be at most 32'])
  })

  it('ignores symbol keys, so a TypeBox schema with its kind markers passes', () => {
    const schema = Type.Object({ q: Type.Optional(Type.String()) })
    expect(Object.getOwnPropertySymbols(schema).length).toBeGreaterThan(0)
    expect(problems({ parameters: { ...schema, [Symbol('extra')]: () => undefined } })).toEqual([])
    const shared = Type.String()
    expect(problems({ parameters: Type.Object({ a: shared, b: shared }) })).toEqual([])
  })

  it('reports a cyclic schema instead of overflowing the stack', () => {
    const cyclic: Record<string, unknown> = { type: 'object', properties: {} }
    ;(cyclic.properties as Record<string, unknown>).self = cyclic
    expect(problems({ parameters: cyclic })).toEqual(['parameters: must be acyclic JSON data'])
  })

  it('reports a schema holding values JSON cannot carry', () => {
    expect(problems({ parameters: { type: 'object', default: Number.NaN } })).toEqual([
      'parameters: must be JSON data',
    ])
    expect(problems({ parameters: { type: 'object', format: () => 'x' } })).toEqual([
      'parameters: must be JSON data',
    ])
    expect(problems({ parameters: { type: 'object', default: new Date(0) } })).toEqual([
      'parameters: must be JSON data',
    ])
    const accessor = Object.defineProperty({ type: 'object' }, 'title', { get: () => 't', enumerable: true })
    expect(problems({ parameters: accessor })).toEqual(['parameters: must be JSON data'])
  })

  it('exports the bounds it enforces', () => {
    expect(TOOL_DESCRIPTION_MAX_LENGTH).toBe(4096)
    expect(TOOL_PARAMETERS_MAX_BYTES).toBe(262_144)
    expect(TOOL_PARAMETERS_MAX_DEPTH).toBe(32)
  })
})
