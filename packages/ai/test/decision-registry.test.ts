import type { DecisionModelRecord, ModelRecord, RouteDecl, RouteTable } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { DecisionAdapter, type DecisionAdapterAnswer, type WireAdapter } from '../src/adapter.js'
import { resolveCredentials } from '../src/credentials.js'
import { buildDecisionRegistry } from '../src/decision-registry.js'
import { AiSetupError } from '../src/errors.js'
import { buildRegistry } from '../src/registry.js'
import { resolveSlot, SlotUnresolved } from '../src/route.js'
import { FakeAdapter, fakeModel } from '../testkit/fake-adapter.js'

const jevModel = (route = 'jev', id = 'jev-1.13.0'): DecisionModelRecord => ({
  id,
  name: id,
  api: 'typesafe-systemone',
  route,
  baseUrl: 'https://decision.invalid/v1',
  kind: 'decision',
  contextWindow: 64000,
  cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
})
const decl = (route: string): RouteDecl => ({
  route,
  api: 'typesafe-systemone',
  baseUrl: 'https://decision.invalid/v1',
  models: [jevModel(route)],
})

class StubDecision extends DecisionAdapter {
  constructor(
    readonly id: string,
    private readonly served: Record<string, readonly DecisionModelRecord[]>,
    private readonly refs: Record<string, string> = {},
  ) {
    super()
  }
  routes(): readonly string[] {
    return Object.keys(this.served)
  }
  models(route: string): readonly DecisionModelRecord[] {
    return this.served[route] ?? []
  }
  credentialDecls() {
    return this.routes().map((route) => ({
      route,
      ...(this.refs[route] ? { credentialRef: this.refs[route] as string } : {}),
    }))
  }
  async decide(): Promise<DecisionAdapterAnswer> {
    return { answers: {}, model: 'x', usage: {} }
  }
  seen(route: string): string | undefined {
    return this.credentialFor(route)
  }
}

const code = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(AiSetupError)
    return (e as AiSetupError).code
  }
  throw new Error('expected an AiSetupError')
}

describe('buildDecisionRegistry', () => {
  it('serves each declared route from the adapter that claims it, with frozen copies', () => {
    const a = new StubDecision('a', { jev: [jevModel()], other: [jevModel('other')] })
    const r = buildDecisionRegistry([a], [decl('other'), decl('jev')])
    expect(r.routes()).toEqual([{ route: 'jev' }, { route: 'other' }])
    expect(r.models().map((m) => [m.route, m.id])).toEqual([
      ['jev', 'jev-1.13.0'],
      ['other', 'jev-1.13.0'],
    ])
    expect(Object.isFrozen(r.models()[0])).toBe(true)
    expect(r.lookup('jev')?.adapter).toBe(a)
    expect(r.lookup('gw')).toBeUndefined()
  })

  it('refuses a declared route no adapter serves', () => {
    expect(code(() => buildDecisionRegistry([new StubDecision('a', {})], [decl('jev')]))).toBe('NO_ADAPTER')
  })

  it('refuses two adapters claiming one route', () => {
    const a = new StubDecision('a', { jev: [jevModel()] })
    const b = new StubDecision('b', { jev: [jevModel()] })
    expect(code(() => buildDecisionRegistry([a, b], [decl('jev')]))).toBe('DUPLICATE_ROUTE')
  })

  it('refuses a chat record offered by a decision adapter', () => {
    const chatRecord = fakeModel({ id: 'gpt', route: 'jev' }) as unknown as DecisionModelRecord
    const a = new StubDecision('a', { jev: [chatRecord] })
    expect(code(() => buildDecisionRegistry([a], [decl('jev')]))).toBe('ADAPTER_KIND')
  })

  it('refuses a record filed under another route', () => {
    const a = new StubDecision('a', { jev: [jevModel('elsewhere')] })
    expect(code(() => buildDecisionRegistry([a], [decl('jev')]))).toBe('ADAPTER_KIND')
  })
})

describe('the chat registry stays chat-only', () => {
  it('refuses a decision adapter outright', () => {
    const a = new StubDecision('a', { jev: [jevModel()] })
    expect(code(() => buildRegistry([a as unknown as WireAdapter]))).toBe('ADAPTER_KIND')
  })

  it('refuses at the seal a wire adapter that lists a decision record', () => {
    const wire = new FakeAdapter({
      id: 'w',
      routes: [{ route: 'gw', api: 'openai-completions', baseUrl: 'https://gw.invalid' }],
      models: { gw: [jevModel('gw') as unknown as ModelRecord] },
    })
    const registry = buildRegistry([wire])
    expect(code(() => registry.seal())).toBe('ADAPTER_KIND')
  })
})

describe('resolveCredentials treats both adapter kinds alike', () => {
  const ref = 'secret://typesafe/default'
  it('binds a decision route credential', () => {
    const a = new StubDecision('a', { jev: [jevModel()] }, { jev: ref })
    resolveCredentials([a], (r) => (r === ref ? 'ts-test-key' : ''))
    expect(a.seen('jev')).toBe('ts-test-key')
  })
  it('stops assembly when it is missing', () => {
    const a = new StubDecision('a', { jev: [jevModel()] }, { jev: ref })
    expect(
      code(() =>
        resolveCredentials([a], () => {
          throw new Error('absent')
        }),
      ),
    ).toBe('SECRET_UNRESOLVED')
  })
  it('honours an optional reference', () => {
    const a = new StubDecision('a', { jev: [jevModel()] }, { jev: ref })
    resolveCredentials(
      [a],
      () => {
        throw new Error('absent')
      },
      { optionalRefs: new Set([ref]) },
    )
    expect(a.seen('jev')).toBeUndefined()
  })
})

describe('resolveSlot for the decision key', () => {
  const chat = buildRegistry([
    new FakeAdapter({
      id: 'w',
      routes: [{ route: 'gw', api: 'openai-completions', baseUrl: 'https://gw.invalid' }],
      models: { gw: [fakeModel({ id: 'm', route: 'gw' })] },
    }),
  ])
  chat.seal()
  const decisions = buildDecisionRegistry([new StubDecision('a', { jev: [jevModel()] })], [decl('jev')])
  const table = (decision?: RouteTable['decision']): RouteTable => ({
    primary: { route: 'gw', model: 'm' },
    ...(decision ? { decision } : {}),
  })
  const unresolved = (fn: () => unknown): SlotUnresolved => {
    try {
      fn()
    } catch (e) {
      expect(e).toBeInstanceOf(SlotUnresolved)
      return e as SlotUnresolved
    }
    throw new Error('expected SlotUnresolved')
  }

  it('resolves only against the decision registry', () => {
    const r = resolveSlot(table({ route: 'jev', model: 'jev-1.13.0' }), chat, 'decision', decisions)
    expect(r).toEqual({ route: 'jev', model: jevModel() })
  })
  it('names the kind when the decision key points at a chat route', () => {
    const e = unresolved(() => resolveSlot(table({ route: 'gw', model: 'm' }), chat, 'decision', decisions))
    expect(e.code).toBe('NO_ADAPTER')
    expect(e.detail).toContain('slot-kind')
  })
  it('reports an absent decision key or an absent registry as unresolved', () => {
    expect(unresolved(() => resolveSlot(table(), chat, 'decision', decisions)).code).toBe('NO_MODEL')
    expect(
      unresolved(() => resolveSlot(table({ route: 'jev', model: 'jev-1.13.0' }), chat, 'decision', undefined))
        .code,
    ).toBe('NO_ADAPTER')
  })
  it('still resolves chat slots against the chat registry only', () => {
    expect(resolveSlot(table(), chat, 'primary').model.id).toBe('m')
  })
})
