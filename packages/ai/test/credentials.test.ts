import type { RouteDecl } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { resolveCredentials } from '../src/credentials.js'
import { AiSetupError } from '../src/index.js'
import { FakeAdapter } from '../testkit/fake-adapter.js'

const routes: RouteDecl[] = [
  {
    route: 'gw',
    api: 'openai-completions',
    baseUrl: 'https://gw.invalid',
    credentialRef: 'secret://agnes/gateway',
  },
  { route: 'open', api: 'openai-completions', baseUrl: 'https://open.invalid' },
]

describe('resolveCredentials', () => {
  it('binds each declared credential once and never logs the value', () => {
    const seen: string[] = []
    const a = new FakeAdapter({ id: 'a', routes, models: {} })
    resolveCredentials([a], (ref) => {
      seen.push(ref)
      return 'sk-value'
    })
    // one call per declared ref, and nothing at all for the route that declares none
    expect(seen).toEqual(['secret://agnes/gateway'])
    expect(a.seenCredential('gw')).toBe('sk-value')
    expect(a.seenCredential('open')).toBeUndefined()
  })

  it('walks every adapter, not only the first', () => {
    const a = new FakeAdapter({ id: 'a', routes: [routes[0] as RouteDecl], models: {} })
    const b = new FakeAdapter({
      id: 'b',
      routes: [{ ...(routes[0] as RouteDecl), route: 'gw2', credentialRef: 'secret://agnes/two' }],
      models: {},
    })
    const seen: string[] = []
    resolveCredentials([a, b], (ref) => {
      seen.push(ref)
      return `value-for-${ref}`
    })
    expect(seen).toEqual(['secret://agnes/gateway', 'secret://agnes/two'])
    expect(a.seenCredential('gw')).toBe('value-for-secret://agnes/gateway')
    expect(b.seenCredential('gw2')).toBe('value-for-secret://agnes/two')
  })

  it('fails assembly when a ref cannot be resolved, without leaking', () => {
    const a = new FakeAdapter({ id: 'a', routes, models: {} })
    try {
      resolveCredentials([a], () => {
        throw new Error('vault down: token=abc')
      })
      expect.fail('an unresolvable credential must stop assembly')
    } catch (e) {
      // Assert the specific rejection: "something threw" would also pass if the thrown error were the
      // secrets callback's own, which is precisely the error whose text must not travel.
      expect(e).toBeInstanceOf(AiSetupError)
      expect((e as AiSetupError).code).toBe('SECRET_UNRESOLVED')
      expect((e as AiSetupError).detail).toEqual({ route: 'gw', ref: 'secret://agnes/gateway' })
      // neither the underlying message nor anything it carried survives into what gets logged
      expect(JSON.stringify((e as AiSetupError).detail)).not.toContain('abc')
      expect((e as Error).message).not.toContain('abc')
      expect((e as Error).message).not.toContain('vault down')
    }
  })

  it('treats an empty string as unresolved rather than binding a blank credential', () => {
    const a = new FakeAdapter({ id: 'a', routes, models: {} })
    let caught: unknown
    try {
      resolveCredentials([a], () => '')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(AiSetupError)
    expect((caught as AiSetupError).code).toBe('SECRET_UNRESOLVED')
    expect((caught as AiSetupError).detail).toEqual({ route: 'gw', ref: 'secret://agnes/gateway' })
    expect(a.seenCredential('gw')).toBeUndefined()
  })

  // A resolved value must never reach an error, so the value itself is tried as the failure text of
  // the *next* lookup: if the implementation ever put a value into detail, this would show it.
  it('keeps a successfully resolved value out of a later failure', () => {
    const a = new FakeAdapter({
      id: 'a',
      routes: [
        routes[0] as RouteDecl,
        { ...(routes[0] as RouteDecl), route: 'gw2', credentialRef: 'secret://agnes/two' },
      ],
      models: {},
    })
    try {
      resolveCredentials([a], (ref) => {
        if (ref === 'secret://agnes/two') throw new Error('sk-first-value')
        return 'sk-first-value'
      })
      expect.fail('the second lookup must fail assembly')
    } catch (e) {
      expect((e as AiSetupError).code).toBe('SECRET_UNRESOLVED')
      expect((e as Error).message).not.toContain('sk-first-value')
      expect(JSON.stringify((e as AiSetupError).detail)).not.toContain('sk-first-value')
    }
  })

  // Fail fast: a bad ref stops assembly there and then, rather than being collected while further
  // secrets are pulled out of the store for adapters that will be discarded anyway.
  it('stops at the first unresolvable ref instead of continuing', () => {
    const a = new FakeAdapter({
      id: 'a',
      routes: [
        routes[0] as RouteDecl,
        { ...(routes[0] as RouteDecl), route: 'gw2', credentialRef: 'secret://agnes/two' },
      ],
      models: {},
    })
    const seen: string[] = []
    expect(() =>
      resolveCredentials([a], (ref) => {
        seen.push(ref)
        return ''
      }),
    ).toThrowError(AiSetupError)
    expect(seen).toEqual(['secret://agnes/gateway'])
  })

  // A store that answers with whitespace has not answered: the value would open the fail-closed
  // gate on the request path and then go out as an empty `Bearer`.
  it('refuses a secret that is nothing but whitespace', () => {
    for (const blank of ['   ', '\t\n']) {
      const a = new FakeAdapter({ id: 'a', routes, models: {} })
      expect(() => resolveCredentials([a], () => blank)).toThrowError(AiSetupError)
      expect(a.seenCredential('gw')).toBeUndefined()
    }
  })

  // And binding one directly leaves the adapter holding nothing, rather than holding a blank.
  it('stores a whitespace credential as absent and trims the rest', () => {
    const a = new FakeAdapter({ id: 'a', routes, models: {} })
    a.bindCredential('gw', 'sk-value')
    a.bindCredential('gw', '   ')
    expect(a.seenCredential('gw')).toBeUndefined()
    a.bindCredential('gw', '  sk-value\n')
    expect(a.seenCredential('gw')).toBe('sk-value')
  })

  // `trim()` removes whitespace and line terminators and nothing else, so a store that answers with
  // a zero-width space, a NUL or a soft hyphen has answered with something that survives it. Two of
  // the three are refused a layer lower by the HTTP client, which reports them as a retryable
  // transport failure rather than the permanent auth failure they are; the third reaches the wire as
  // a `Bearer` followed by one invisible character. None of them can authenticate anything, so the
  // gate that calls a blank credential absent has to call these absent too.
  it('refuses a secret with no printable character', () => {
    for (const invisible of ['\u200b', '\u0000', '\u00ad', '\u00a0\u200b', '\ufeff\u00ad', '\u0000\u0000']) {
      const a = new FakeAdapter({ id: 'a', routes, models: {} })
      expect(() => resolveCredentials([a], () => invisible)).toThrowError(AiSetupError)
      expect(a.seenCredential('gw')).toBeUndefined()
    }
  })

  // The rule is about a value that is invisible in its entirety, not about which characters a secret
  // may contain: one printable character is enough, and the value is bound as the store gave it.
  it('keeps a secret that contains a printable character', () => {
    const a = new FakeAdapter({ id: 'a', routes, models: {} })
    resolveCredentials([a], () => '\u200bsk-value')
    expect(a.seenCredential('gw')).toBe('\u200bsk-value')
  })

  it('stores an invisible-only credential as absent when bound directly', () => {
    const a = new FakeAdapter({ id: 'a', routes, models: {} })
    a.bindCredential('gw', 'sk-value')
    a.bindCredential('gw', '\u00ad')
    expect(a.seenCredential('gw')).toBeUndefined()
  })

  it('does nothing at all when no route declares a credential', () => {
    const a = new FakeAdapter({ id: 'a', routes: [routes[1] as RouteDecl], models: {} })
    let calls = 0
    resolveCredentials([a], () => {
      calls++
      return 'sk-value'
    })
    expect(calls).toBe(0)
    expect(a.seenCredential('open')).toBeUndefined()
  })
})
