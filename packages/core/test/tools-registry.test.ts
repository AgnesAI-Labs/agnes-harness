import type { ToolDef } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../src/registry/tools.js'
import { CoreError } from '../src/types.js'

const meta = {
  isReadOnly: true,
  isDestructive: false,
  isConcurrencySafe: true,
  isOpenWorld: false,
  replay: 'safe' as const,
  costHint: undefined,
  deferLoading: undefined,
  requiresApproval: undefined,
}
// Typed as ToolDef rather than `never` so a case below can spread one and replace a single key;
// `never` is assignable to every parameter but cannot itself be spread.
const def = (name: string, extra: Record<string, unknown> = {}): ToolDef =>
  ({
    name,
    description: 'd',
    parameters: { type: 'object', properties: {} },
    meta: { ...meta, ...extra },
    execute: async () => ({ content: [] }),
  }) as unknown as ToolDef

const codeOf = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    return (e as CoreError).code
  }
  return 'no throw'
}

describe('ToolRegistry', () => {
  it('adds, resolves, lists, counts and disposes', () => {
    const r = new ToolRegistry()
    expect(r.size).toBe(0)
    const off = r.add(def('read'), { source: 'agnes/tools-core', trust: 'builtin' })
    expect(r.resolve('read')?.source).toEqual({ source: 'agnes/tools-core', trust: 'builtin' })
    expect(r.resolve('read')).toMatchObject({
      executionDomain: 'workspace',
      definitionFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    expect(r.list().map((d) => d.name)).toEqual(['read'])
    expect(r.size).toBe(1)
    off()
    expect(r.resolve('read')).toBeUndefined()
    expect(r.size).toBe(0)
  })

  it('requires trusted package provenance for classifiers and fingerprints stable definition inputs', () => {
    const classified = {
      ...def('computer_use'),
      policyVersion: 'computer-use-v1',
      classify: () => ({
        isReadOnly: true,
        isDestructive: false,
        replay: 'safe' as const,
        requiresApproval: 'never' as const,
        approvalScopes: [],
      }),
    } as ToolDef
    const r = new ToolRegistry()
    expect(() => r.add(classified, { source: 'agnes/computer-use', trust: 'builtin' })).toThrow(
      /require Host-attested package identity and version/,
    )
    const provenance = {
      source: 'agnes/computer-use',
      trust: 'builtin' as const,
      packageIdentity: '@agnes/base',
      packageVersion: '1.2.3',
    }
    r.add(classified, provenance)
    const first = r.resolve('computer_use')?.definitionFingerprint
    const same = new ToolRegistry()
    same.add(classified, provenance)
    expect(same.resolve('computer_use')?.definitionFingerprint).toBe(first)
    const changed = new ToolRegistry()
    changed.add({ ...classified, policyVersion: 'computer-use-v2' }, provenance)
    expect(changed.resolve('computer_use')?.definitionFingerprint).not.toBe(first)
  })

  it('only accepts the host-computer-use domain for the exact built-in package and extension', () => {
    const exact = {
      source: 'agnes/computer-use',
      trust: 'builtin' as const,
      packageIdentity: '@agnes/base',
      packageVersion: '1.0.0',
      executionDomain: 'host-computer-use' as const,
    }
    const accepted = new ToolRegistry()
    accepted.add(def('computer_use'), exact)
    expect(accepted.resolve('computer_use')?.executionDomain).toBe('host-computer-use')

    for (const forged of [
      { ...exact, source: 'third-party/computer-use' },
      { ...exact, trust: 'trusted' as const },
      { ...exact, packageIdentity: 'third-party' },
      { ...exact, packageVersion: '' },
    ]) {
      const registry = new ToolRegistry()
      expect(() => registry.add(def('computer_use'), forged)).toThrow(
        /host-computer-use requires exact built-in package attestation/,
      )
      expect(registry.size).toBe(0)
    }
  })

  it('disposes only the registration it was handed out for', () => {
    // A disposer that deleted by name would, when called late, remove whichever tool had since
    // claimed the name — an extension unloading after a reload would silently unregister the
    // replacement.
    const r = new ToolRegistry()
    const stale = r.add(def('read'), { source: 'first', trust: 'builtin' })
    stale()
    r.add(def('read'), { source: 'second', trust: 'trusted' })
    stale()
    expect(r.resolve('read')?.source.source).toBe('second')
  })

  it('delegates well-formedness to extension-api checkToolDef and rejects duplicates', () => {
    const r = new ToolRegistry()
    // CoreError, not ExtensionError: both packages spell E_TOOLDEF_META, so matching the message
    // alone would not say which gate fired.
    expect(() => r.add(def('bad-name'), { source: 's', trust: 'trusted' })).toThrow(CoreError)
    expect(codeOf(() => r.add(def('bad-name'), { source: 's', trust: 'trusted' }))).toBe('E_TOOLDEF_META')
    expect(() => r.add(def('bad-name'), { source: 's', trust: 'trusted' })).toThrow(
      /name: must match \^\[A-Za-z_\]/,
    )
    const { costHint: _dropped, ...seven } = meta
    expect(() =>
      r.add({ ...def('x'), meta: seven } as unknown as ToolDef, { source: 's', trust: 'trusted' }),
    ).toThrow(/meta\.costHint: missing/)
    expect(() => r.add(def('y', { replay: 'maybe' }), { source: 's', trust: 'trusted' })).toThrow(
      /replay: expected safe \| never \| idempotent/,
    )
    // These three are what the hand-copied check in core used to miss, and are the reason it is
    // gone: a misspelled costHint key, an open requiresApproval string and a non-boolean flag.
    expect(() => r.add(def('c1', { costHint: { credit: 3 } }), { source: 's', trust: 'trusted' })).toThrow(
      /costHint: unknown key credit/,
    )
    expect(() =>
      r.add(def('c2', { requiresApproval: 'sometimes' }), { source: 's', trust: 'trusted' }),
    ).toThrow(/requiresApproval: expected never \| destructive \| always \| undefined/)
    expect(() => r.add(def('c3', { isReadOnly: 'yes' }), { source: 's', trust: 'trusted' })).toThrow(
      /isReadOnly: expected boolean/,
    )
    // Every rejection above left the table empty: a refused tool must not be half-registered.
    expect(r.size).toBe(0)
    r.add(def('z'), { source: 's', trust: 'trusted' })
    expect(codeOf(() => r.add(def('z'), { source: 's2', trust: 'trusted' }))).toBe('E_REGISTRY_DUPLICATE')
    expect(r.resolve('z')?.source.source).toBe('s')
  })

  it('carries the failing tool name and the problem list on the error detail', () => {
    const r = new ToolRegistry()
    let detail: Record<string, unknown> | undefined
    try {
      r.add(def('c4', { replay: 'maybe', isOpenWorld: 'no' }), { source: 's', trust: 'trusted' })
    } catch (e) {
      detail = (e as CoreError).detail
    }
    expect(detail?.name).toBe('c4')
    expect(detail?.problems).toEqual([
      'meta.isOpenWorld: expected boolean',
      'meta.replay: expected safe | never | idempotent',
    ])
  })

  it('filters by trust, by name and by deferred loading', () => {
    const r = new ToolRegistry()
    r.add(def('a'), { source: 's', trust: 'builtin' })
    r.add(def('b', { deferLoading: true }), { source: 's', trust: 'trusted' })
    r.add(def('c'), { source: 's', trust: 'trusted' })
    expect(r.list({ trust: 'trusted' }).map((d) => d.name)).toEqual(['b', 'c'])
    expect(r.list({ deferred: true }).map((d) => d.name)).toEqual(['b'])
    expect(r.list({ deferred: false }).map((d) => d.name)).toEqual(['a', 'c'])
    expect(r.list({ names: ['a', 'c'] }).map((d) => d.name)).toEqual(['a', 'c'])
    expect(r.list({ trust: 'trusted', names: ['a', 'c'] }).map((d) => d.name)).toEqual(['c'])
  })

  it('snapshot freezes itself and its defs array, is hashed and unaffected by later adds', () => {
    const r = new ToolRegistry()
    const authorDefinition = def('a')
    r.add(authorDefinition, { source: 's', trust: 'builtin' })
    const snap = r.snapshot(7)
    r.add(def('b'), { source: 's', trust: 'builtin' })
    expect(snap.defs.map((d) => d.name)).toEqual(['a'])
    expect(snap.byName.has('b')).toBe(false)
    expect(snap.takenAtSeq).toBe(7)
    expect(snap.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(Object.isFrozen(snap)).toBe(true)
    expect(Object.isFrozen(snap.defs)).toBe(true)
    expect(Object.isFrozen(authorDefinition)).toBe(false)
    expect(Object.isFrozen(snap.defs[0])).toBe(true)
    expect(Object.isFrozen(r.resolve('a')?.source)).toBe(true)
    expect(r.list({ deferred: false, names: ['b'] }).map((d) => d.name)).toEqual(['b'])
  })

  it('snapshots the parameter schema so caller mutation cannot drift validation from its fingerprint', () => {
    const schemaKind = Symbol('schema-kind')
    const parameters = {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
      [schemaKind]: 'Object',
    }
    const definition = { ...def('read'), parameters } as unknown as ToolDef
    const r = new ToolRegistry()
    r.add(definition, { source: 's', trust: 'trusted' })
    const registered = r.resolve('read')
    if (!registered) throw new Error('missing registered tool')
    const fingerprint = registered.definitionFingerprint
    const snapshotHash = r.snapshot(1).hash

    parameters.properties.value.type = 'number'
    parameters.required.push('other')

    expect(registered.parameters).toMatchObject({
      properties: { value: { type: 'string' } },
      required: ['value'],
    })
    expect(registered.definitionFingerprint).toBe(fingerprint)
    expect(r.snapshot(2).hash).toBe(snapshotHash)
    expect((registered.parameters as unknown as Record<symbol, unknown>)[schemaKind]).toBe('Object')
    expect(Object.isFrozen(registered.parameters)).toBe(true)
    expect(Object.isFrozen((registered.parameters as unknown as { properties: object }).properties)).toBe(
      true,
    )
  })

  it('rejects accessor-backed parameter schemas instead of freezing a live getter', () => {
    let kind = 'string'
    const valueSchema: Record<string, unknown> = {}
    Object.defineProperty(valueSchema, 'type', {
      enumerable: true,
      get: () => kind,
    })
    const definition = {
      ...def('read'),
      parameters: { type: 'object', properties: { value: valueSchema } },
    } as unknown as ToolDef
    const r = new ToolRegistry()
    expect(() => r.add(definition, { source: 's', trust: 'trusted' })).toThrow(
      /parameter schema must contain only plain data/,
    )
    kind = 'number'
    expect(r.size).toBe(0)
  })

  it('snapshots tool and source metadata once before validating or fingerprinting it', () => {
    let metaReads = 0
    const changingMeta = { ...meta } as Record<string, unknown>
    Object.defineProperty(changingMeta, 'isReadOnly', {
      enumerable: true,
      get: () => ++metaReads === 1,
    })
    let sourceReads = 0
    const source = {
      get source() {
        sourceReads++
        return sourceReads === 1 ? 'first' : 'drifted'
      },
      trust: 'trusted' as const,
    }
    const r = new ToolRegistry()
    r.add({ ...def('read'), meta: changingMeta } as unknown as ToolDef, source)
    expect(metaReads).toBe(1)
    expect(sourceReads).toBe(1)
    expect(r.resolve('read')?.meta.isReadOnly).toBe(true)
    expect(r.resolve('read')?.source.source).toBe('first')
    expect(r.registrations('first')).toEqual(['tool:read'])
  })

  it('hashes names and parameter schemas, independent of registration order', () => {
    const one = new ToolRegistry()
    one.add(def('a'), { source: 's', trust: 'builtin' })
    one.add(def('b'), { source: 's', trust: 'builtin' })
    const other = new ToolRegistry()
    other.add(def('b'), { source: 'other', trust: 'trusted' })
    other.add(def('a'), { source: 'other', trust: 'trusted' })
    // Same names and schemas registered in the other order, from another source, at another seq:
    // the hash is over what the model sees, so it must be equal.
    expect(other.snapshot(99).hash).toBe(one.snapshot(1).hash)
    const changed = new ToolRegistry()
    changed.add(def('a'), { source: 's', trust: 'builtin' })
    changed.add({ ...def('b'), parameters: { type: 'string' } } as unknown as ToolDef, {
      source: 's',
      trust: 'builtin',
    })
    expect(changed.snapshot(1).hash).not.toBe(one.snapshot(1).hash)
    const renamed = new ToolRegistry()
    renamed.add(def('a'), { source: 's', trust: 'builtin' })
    renamed.add(def('bb'), { source: 's', trust: 'builtin' })
    expect(renamed.snapshot(1).hash).not.toBe(one.snapshot(1).hash)
  })
})
