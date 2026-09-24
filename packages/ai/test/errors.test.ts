import { describe, expect, it } from 'vitest'
import { AiSetupError } from '../src/index.js'

describe('AiSetupError', () => {
  it('carries the code and the detail in the message', () => {
    const e = new AiSetupError('NO_ADAPTER', { route: 'gw' })
    expect(e.message).toBe('NO_ADAPTER {"route":"gw"}')
    expect(e.code).toBe('NO_ADAPTER')
    expect(e.detail).toEqual({ route: 'gw' })
  })

  // The constructor is on the failure path, so it has to survive whatever detail a caller hands it.
  // A circular structure or a BigInt would make JSON.stringify throw from inside `super(...)`,
  // replacing a precise assembly error with an unrelated TypeError from an unrelated stack frame.
  it('survives a circular detail and still reports the code', () => {
    const cyclic: Record<string, unknown> = { route: 'gw' }
    cyclic.self = cyclic
    const e = new AiSetupError('DUPLICATE_ROUTE', cyclic)
    expect(e.code).toBe('DUPLICATE_ROUTE')
    expect(e.message).toContain('DUPLICATE_ROUTE')
    expect(e.message).toContain('route')
    expect(e.detail).toBe(cyclic)
  })

  it('survives a BigInt detail', () => {
    const e = new AiSetupError('CONTRACT_MISMATCH', { route: 'gw', at: 1n })
    expect(e.code).toBe('CONTRACT_MISMATCH')
    expect(e.message).toBe('CONTRACT_MISMATCH {"route":"gw","at":"1"}')
  })

  // The degraded form must stay as leak-proof as the normal one: an unserialisable detail reports
  // its key names only, never its values, because this message is what reaches a log.
  it('names only the keys, never the values, when the detail cannot be serialised', () => {
    const cyclic: Record<string, unknown> = { ref: 'secret://agnes/gateway', token: 'sk-TOPSECRET' }
    cyclic.self = cyclic
    const e = new AiSetupError('SECRET_UNRESOLVED', cyclic)
    expect(e.message).not.toContain('sk-TOPSECRET')
    expect(e.message).not.toContain('secret://')
    expect(e.message).toContain('ref,token,self')
  })

  // The degradation path itself runs the detail's own traps, so it is reachable code with hostile
  // input. A trap that throws would escape `super(...)` carrying its own message, which is the exact
  // failure the fallback exists to prevent — only now the thrown text is chosen by whoever built the
  // detail.
  it('survives a detail whose own-key lookup throws', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('ownKeys boom sk-TOPSECRET-9999')
        },
      },
    ) as Record<string, unknown>
    const e = new AiSetupError('SECRET_UNRESOLVED', hostile)
    expect(e.code).toBe('SECRET_UNRESOLVED')
    expect(e.message).toBe('SECRET_UNRESOLVED {unserialisable detail}')
    expect(e.message).not.toContain('sk-TOPSECRET-9999')
  })

  // Key names are safe to print only because every caller in this package writes literal ones. An
  // exotic detail chooses its own key names, so it can present a secret as a key and have the
  // key-names-only fallback publish it. Names off the shape this package writes are counted, not
  // printed.
  it('does not print key names an exotic detail chose for itself', () => {
    const leaky = new Proxy(
      {},
      {
        ownKeys: () => ['route', 'sk-TOPSECRET-9999'],
        getOwnPropertyDescriptor: () => ({ value: 1, enumerable: true, configurable: true }),
        get() {
          throw new Error('nope')
        },
      },
    ) as Record<string, unknown>
    const e = new AiSetupError('SECRET_UNRESOLVED', leaky)
    expect(e.message).not.toContain('sk-TOPSECRET-9999')
    expect(e.message).toBe('SECRET_UNRESOLVED {unserialisable detail, keys: route,+1 unprintable}')
  })
})
