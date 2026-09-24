import type { ModelRecord, RequestBody, RouteDecl } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { type AdapterStreamOptions, AiSetupError, WireAdapter, type WireEvent } from '../src/index.js'

// A minimal concrete adapter: the base class is abstract, and the credential store is protected, so
// reaching it needs a subclass. This one exists only to exercise the base class.
class ProbeAdapter extends WireAdapter {
  readonly id = 'probe'
  routes(): RouteDecl[] {
    return []
  }
  models(): ModelRecord[] {
    return []
  }
  // biome-ignore lint/correctness/useYield: the base class demands the method; this adapter never streams
  async *stream(_route: string, _req: RequestBody, _opts: AdapterStreamOptions): AsyncIterable<WireEvent> {
    throw new Error('not used')
  }
  read(route: string): string | undefined {
    return this.credentialFor(route)
  }
}

describe('WireAdapter credential store', () => {
  it('keeps one value per route and hands back nothing for an unbound route', () => {
    const a = new ProbeAdapter()
    expect(a.read('gw')).toBeUndefined()
    a.bindCredential('gw', 'sk-one')
    a.bindCredential('other', 'sk-two')
    expect(a.read('gw')).toBe('sk-one')
    expect(a.read('other')).toBe('sk-two')
  })
  it('rebinding replaces the previous value, and undefined clears it', () => {
    const a = new ProbeAdapter()
    a.bindCredential('gw', 'sk-one')
    a.bindCredential('gw', 'sk-two')
    expect(a.read('gw')).toBe('sk-two')
    a.bindCredential('gw', undefined)
    expect(a.read('gw')).toBeUndefined()
  })
  // A TypeScript `private` field would satisfy the type checker and still leave the store as an
  // ordinary own property: visible to Object.keys, to a generic object walk, and to any logger that
  // serialises the adapter. These assertions pin the runtime-private spelling instead.
  it('does not expose the credential store through the adapter instance itself', () => {
    const a = new ProbeAdapter()
    a.bindCredential('gw', 'sk-secret')
    expect(JSON.stringify(a)).not.toContain('sk-secret')
    expect(Object.keys(a)).toEqual(['id'])
    expect(Object.getOwnPropertyNames(a)).toEqual(['id'])
    expect((a as unknown as Record<string, unknown>).credentials).toBeUndefined()
  })
})

describe('AiSetupError', () => {
  it('carries the code and detail, and reads them back off a caught error', () => {
    const e = new AiSetupError('DUPLICATE_ROUTE', { route: 'r1', adapters: ['a', 'b'] })
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('AiSetupError')
    expect(e.code).toBe('DUPLICATE_ROUTE')
    expect(e.detail).toEqual({ route: 'r1', adapters: ['a', 'b'] })
  })
  it('puts the code and detail in the message, so a bare log line still identifies the failure', () => {
    expect(new AiSetupError('NO_ADAPTER', { route: 'r9' }).message).toBe('NO_ADAPTER {"route":"r9"}')
  })
  it('defaults detail to an empty object rather than undefined', () => {
    expect(new AiSetupError('CONTRACT_MISMATCH').detail).toEqual({})
  })
})
