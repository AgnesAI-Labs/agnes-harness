import type { HookContext, HookHandler, HookPayloadMap } from '@agnes/extension-api'
import { unavailableProjections } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import { platformFacts } from '../src/effects/platform-facts.js'
import { HookEngine } from '../src/hooks/engine.js'
import { contextReturnToWire } from '../src/hooks/returns.js'
import { HookRegistry } from '../src/registry/hooks.js'
import { applyContextResults, type ContextResult } from '../src/request/transforms.js'
import { fakeSeams } from './helpers/fake-seams.js'

const platform = platformFacts(fakeSeams().platform)
const context = (): HookContext => ({
  session: { key: 'session', lane: 'main', workspaceRoot: '/workspace', turn: 1, step: 2 },
  projections: unavailableProjections,
  replayed: false,
  signal: new AbortController().signal,
  lease: { expiresAt: '2099-01-01T00:00:00Z', scope: { events: true }, budget: { remaining: 10 } },
  log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
  platform,
})
const meta = { source: 'agnes/test', trust: 'trusted' as const }
const payload: HookPayloadMap['before_step'] = {
  turn: 1,
  step: 2,
  depth: 0,
  budget: { remaining: 10, cap: null },
}
const engine = () => new HookEngine({ onFailure: () => undefined, diag: () => undefined, platform })

describe('HookEngine typed invocation', () => {
  it('calls the actual two-argument author handler with identity, lease, logging and scoped signal', async () => {
    const e = engine(),
      ctx = context()
    let got: HookContext | undefined
    const handler: HookHandler<'before_step'> = (p, c) => {
      expect(p).toEqual(payload)
      got = c
      expect(c.signal.aborted).toBe(false)
      expect(Object.keys(c.log)).toEqual(['debug', 'info', 'warn', 'error'])
      expect(c.platform).toBe(platform)
      expect(Object.keys(c).sort()).toEqual([
        'lease',
        'log',
        'platform',
        'projections',
        'replayed',
        'session',
        'signal',
      ])
      return { block: false }
    }
    e.on('before_step', handler, meta)
    expect(await e.dispatch('before_step', () => payload, ctx)).toMatchObject({
      kind: 'ok',
      results: [{ value: { block: false } }],
    })
    expect(got?.session).toEqual(ctx.session)
    expect(got?.lease).toEqual(ctx.lease)
    expect(got?.replayed).toBe(false)
    expect(got?.signal).not.toBe(ctx.signal)
    expect(got?.signal.aborted).toBe(true)
    expect(ctx.signal.aborted).toBe(false)
  })

  it('isolates nested input and context from extension mutation', async () => {
    const e = engine(),
      ctx = context()
    e.on(
      'before_step',
      (p, c) => {
        expect(Reflect.set(p.budget, 'remaining', 999)).toBe(false)
        expect(Reflect.set(c.session, 'key', 'forged')).toBe(false)
        expect(Reflect.set(c.lease.budget, 'remaining', 999)).toBe(false)
        expect(Reflect.set(c.log, 'info', () => undefined)).toBe(false)
        return {}
      },
      meta,
    )
    e.on(
      'before_step',
      (p, c) => {
        expect(p.budget.remaining).toBe(10)
        expect(c.session.key).toBe('session')
        return {}
      },
      meta,
    )
    expect((await e.dispatch('before_step', () => payload, ctx)).kind).toBe('ok')
    expect(payload.budget.remaining).toBe(10)
    expect(Object.isFrozen(ctx.session)).toBe(false)
  })

  it('retains an already-frozen host session capability without making it mutable', async () => {
    const original = context()
    const canonical = Object.freeze({ ...original.session })
    const e = new HookEngine({
      onFailure: () => undefined,
      diag: () => undefined,
      retainSessionRefIdentity: (session) => session === canonical,
      platform,
    })
    const ctx: HookContext = { ...original, session: canonical }
    let received: HookContext['session'] | undefined
    e.on(
      'before_step',
      (_payload, hookContext) => {
        received = hookContext.session
        expect(Reflect.set(hookContext.session, 'key', 'forged')).toBe(false)
        return {}
      },
      meta,
    )
    expect((await e.dispatch('before_step', () => payload, ctx)).kind).toBe('ok')
    expect(received).toBe(canonical)
    expect(canonical.key).toBe('session')
    expect(Object.isFrozen(received)).toBe(true)
  })

  it('does not mistake a caller-frozen session object for a host capability', async () => {
    const nested = { value: 'original' }
    const supplied = Object.freeze({ key: 'session', lane: 'main', workspaceRoot: '/workspace', nested })
    const ctx = { ...context(), session: supplied } as HookContext
    let received: HookContext['session'] | undefined
    const e = engine()
    e.on(
      'before_step',
      (_payload, hookContext) => {
        received = hookContext.session
        const child = (hookContext.session as HookContext['session'] & { nested: { value: string } }).nested
        expect(Reflect.set(child, 'value', 'forged')).toBe(false)
        return {}
      },
      meta,
    )
    expect((await e.dispatch('before_step', () => payload, ctx)).kind).toBe('ok')
    expect(received).not.toBe(supplied)
    expect(nested.value).toBe('original')
  })

  it('rejects an accessor session identity without invoking its getter', async () => {
    let reads = 0
    const supplied = { lane: 'main' } as Record<string, unknown>
    Object.defineProperty(supplied, 'key', {
      enumerable: true,
      get() {
        reads++
        return 'session'
      },
    })
    await expect(
      engine().dispatch('before_step', () => payload, {
        ...context(),
        session: supplied as unknown as HookContext['session'],
      }),
    ).rejects.toThrow('cannot contain accessors')
    expect(reads).toBe(0)
  })

  it('preserves logger method receivers while exposing only the logging interface', async () => {
    const e = engine(),
      ctx = context()
    let receiver: unknown
    ctx.log.info = function () {
      receiver = this
    }
    e.on(
      'before_step',
      (_p, c) => {
        c.log.info('test')
        return {}
      },
      meta,
    )
    await e.dispatch('before_step', () => payload, ctx)
    expect(receiver).toBe(ctx.log)
  })

  it('copies registration attribution and makes disposal idempotent', async () => {
    const e = engine(),
      source = { ...meta }
    const dispose = e.on('before_step', () => ({}), source)
    source.source = 'agnes/forged'
    expect(await e.dispatch('before_step', () => payload, context())).toMatchObject({
      results: [{ source: 'agnes/test' }],
    })
    dispose()
    dispose()
    expect(await e.dispatch('before_step', () => payload, context())).toEqual({ kind: 'ok', results: [] })
  })

  it('keeps an in-flight registration snapshot while disposal affects the next dispatch', async () => {
    const e = engine()
    let count = 0
    let dispose: () => void = () => undefined
    e.on(
      'before_step',
      () => {
        dispose()
        return {}
      },
      meta,
    )
    dispose = e.on(
      'before_step',
      () => {
        count++
        return {}
      },
      meta,
    )
    await e.dispatch('before_step', () => payload, context())
    expect(count).toBe(1)
    await e.dispatch('before_step', () => payload, context())
    expect(count).toBe(1)
  })

  it('validates author returns before accepting changes or running downstream handlers', async () => {
    const e = engine()
    let later = false,
      accepted = false
    e.on(
      'context',
      (() => ({ sections: [{ id: 'x', order: 1, text: 'wire' }] })) as unknown as HookHandler<'context'>,
      meta,
    )
    e.on(
      'context',
      () => {
        later = true
        return {}
      },
      meta,
    )
    const result = await e.dispatch(
      'context',
      () => ({ sections: [], surfaceDigest: { nodes: 0, tokensEstimate: 0 }, getSurface: () => [] }),
      context(),
      {
        accept: () => {
          accepted = true
        },
      },
    )
    expect(result.kind).toBe('rejected')
    expect(later).toBe(false)
    expect(accepted).toBe(false)
  })

  it('uses real author context handlers and core18 transformations across waterfall stages', async () => {
    const e = engine()
    const collected: Array<{ ext: string; result: ContextResult }> = []
    let sections = applyContextResults([], []).sections
    let surfaceReads = 0
    const surface = [{ seq: 1, type: 'user/message' as const, pinned: true }]
    e.on(
      'context',
      (p, c) => {
        expect(surfaceReads).toBe(0)
        const read = p.getSurface()
        expect(Reflect.set(read[0] ?? {}, 'pinned', false)).toBe(false)
        expect(c.session.key).toBe('session')
        return {
          sections: [{ id: 'custom', order: 1, content: 'first', source: 'forged' }],
          additionalContext: 'note',
        }
      },
      meta,
    )
    e.on(
      'context',
      (p) => {
        expect(p.sections[0]).toEqual({ id: 'custom', order: 1, content: 'first', source: 'agnes/test' })
        return { additionalContext: 'note' }
      },
      { source: 'agnes/second', trust: 'builtin' },
    )
    const result = await e.dispatch(
      'context',
      () => ({
        sections: sections.map(({ text, ...s }) => ({ ...s, content: text })),
        surfaceDigest: { nodes: 1, tokensEstimate: 10 },
        getSurface: () => {
          surfaceReads++
          return surface
        },
      }),
      context(),
      {
        accept: (value, source) => {
          collected.push({ ext: source, result: contextReturnToWire(value) })
          sections = applyContextResults([], collected).sections
        },
      },
    )
    expect(result.kind).toBe('ok')
    expect(surfaceReads).toBe(1)
    expect(surface[0]?.pinned).toBe(true)
    expect(sections.map((s) => s.text)).toEqual(['first', 'note'])
  })

  it('puts replay state in HookContext without extending the payload', async () => {
    const e = engine()
    const states: boolean[] = []
    e.on(
      'session_start',
      (p, c) => {
        expect(Object.hasOwn(p, 'replayed')).toBe(false)
        states.push(c.replayed)
      },
      meta,
    )
    await e.dispatch('session_start', () => ({ reason: 'resume', preset: 'standard', cwd: '/workspace' }), {
      ...context(),
      replayed: true,
    })
    expect(states).toEqual([true])
  })

  it('uses event-specific terminal decisions with typed author returns', async () => {
    const e = engine()
    let calls = 0
    e.on('before_step', () => ({ block: true, reason: 'hold' }), meta)
    e.on(
      'before_step',
      () => {
        calls++
        return {}
      },
      meta,
    )
    const result = await e.dispatch('before_step', () => payload, context(), {
      terminal: (value) => value.block === true,
    })
    expect(result).toMatchObject({ results: [{ value: { block: true, reason: 'hold' } }] })
    expect(calls).toBe(0)
  })

  it('rejects forged extension attribution and trust', () => {
    const e = engine()
    expect(() => e.on('before_step', () => ({}), { ...meta, source: 'core' })).toThrow()
    expect(() => e.on('before_step', () => ({}), { ...meta, trust: 'untrusted' as never })).toThrow(
      'invalid hook registration',
    )
  })
})

describe('shared HookRegistry', () => {
  it('owns immutable snapshots and live disposal accounting across events and sources', () => {
    const registry = new HookRegistry(),
      source = { ...meta }
    const first = registry.on('before_step', () => ({}), source)
    const second = registry.on('before_step', () => ({}), source)
    registry.on('shutdown', () => undefined, { source: 'agnes/other', trust: 'builtin' })
    const snapshot = registry.snapshot()
    source.source = 'agnes/forged'
    expect(registry.registrations(meta.source)).toEqual(['hook:before_step', 'hook:before_step'])
    expect(registry.registrations('agnes/other')).toEqual(['hook:shutdown'])
    first()
    first()
    expect(registry.registrations(meta.source)).toEqual(['hook:before_step'])
    second()
    registry.on('context', () => ({}), meta)
    expect(snapshot.entries('before_step')).toHaveLength(2)
    expect(snapshot.entries('context')).toEqual([])
    expect(registry.snapshot().entries('before_step')).toEqual([])
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.entries('before_step'))).toBe(true)
    const entry = snapshot.entries('before_step')[0]
    expect(Reflect.set(entry ?? {}, 'handler', () => ({ block: true }))).toBe(false)
    expect(Reflect.set(entry?.meta ?? {}, 'source', 'agnes/forged')).toBe(false)
    expect(entry?.meta.source).toBe(meta.source)
  })

  it('rejects a negative or non-integer hookRank', () => {
    const registry = new HookRegistry()
    expect(() => registry.on('before_step', () => ({}), { ...meta, hookRank: -1 })).toThrow('E_ENVELOPE')
    expect(() => registry.on('before_step', () => ({}), { ...meta, hookRank: 1.5 })).toThrow('E_ENVELOPE')
    expect(() =>
      registry.on('before_step', () => ({}), { ...meta, hookRank: Number.MAX_SAFE_INTEGER + 1 }),
    ).toThrow('E_ENVELOPE')
  })

  it('dispatches the built-in (ranked) layer first in ascending rank order, then third parties in registration order', () => {
    const registry = new HookRegistry()
    // Registered out of both rank and insertion order on purpose, to prove the snapshot sorts
    // rather than merely preserving whatever order callers happened to register in.
    registry.on('before_step', () => ({}), { source: 'agnes/third-party-a', trust: 'trusted' })
    registry.on('before_step', () => ({}), { source: 'agnes/privacy', trust: 'builtin', hookRank: 5 })
    registry.on('before_step', () => ({}), { source: 'agnes/third-party-b', trust: 'trusted' })
    registry.on('before_step', () => ({}), { source: 'agnes/hooks-runner', trust: 'builtin', hookRank: 1 })
    const order = registry
      .snapshot()
      .entries('before_step')
      .map((entry) => entry.meta.source)
    expect(order).toEqual([
      'agnes/hooks-runner',
      'agnes/privacy',
      'agnes/third-party-a',
      'agnes/third-party-b',
    ])
  })

  it('feeds two real engines while keeping observe quotas and resets session-local', async () => {
    const registry = new HookRegistry(),
      calls: string[] = []
    registry.on(
      'session_start',
      (_p, ctx) => {
        calls.push(ctx.session.key)
      },
      meta,
    )
    const options = { eventsPerTurn: 1, onFailure: () => undefined, diag: () => undefined, platform }
    const a = new HookEngine(options, registry),
      b = new HookEngine(options, registry)
    const run = (e: HookEngine, key: string) =>
      e.dispatch('session_start', () => ({ reason: 'new', preset: 'standard', cwd: '/workspace' }), {
        ...context(),
        session: { ...context().session, key },
      })
    await run(a, 'a')
    await run(a, 'a')
    await run(b, 'b')
    expect(calls).toEqual(['a', 'b'])
    a.resetTurn()
    await run(a, 'a')
    await run(b, 'b')
    expect(calls).toEqual(['a', 'b', 'a'])
  })

  it('shares registrations without letting a concurrent dispatch alter an in-flight snapshot', async () => {
    const registry = new HookRegistry()
    const a = new HookEngine({ onFailure: () => undefined, diag: () => undefined, platform }, registry)
    const b = new HookEngine({ onFailure: () => undefined, diag: () => undefined, platform }, registry)
    let release: () => void = () => undefined
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered: () => void = () => undefined
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    const dispose = a.on(
      'before_step',
      async () => {
        entered()
        await barrier
        return { reason: 'old' }
      },
      meta,
    )
    const pending = a.dispatch('before_step', () => payload, context())
    await ready
    dispose()
    registry.on('before_step', () => ({ reason: 'new' }), meta)
    expect(await b.dispatch('before_step', () => payload, context())).toMatchObject({
      results: [{ value: { reason: 'new' } }],
    })
    release()
    expect(await pending).toMatchObject({ results: [{ value: { reason: 'old' } }] })
    expect(await a.dispatch('before_step', () => payload, context())).toMatchObject({
      results: [{ value: { reason: 'new' } }],
    })
  })
})

it('resolves each registered source lease without requiring a fictional shared session lease', async () => {
  const first = context().lease,
    second = { ...context().lease, budget: { remaining: 3 } }
  const leases = new Map([
    ['agnes/first', first],
    ['agnes/second', second],
  ])
  const seen: number[] = []
  const e = new HookEngine({ onFailure() {}, diag() {}, leaseFor: (source) => leases.get(source), platform })
  for (const source of leases.keys())
    e.on(
      'before_step',
      (_payload, ctx) => {
        seen.push(ctx.lease.budget.remaining)
        expect(Object.isFrozen(ctx.lease)).toBe(true)
        expect(Reflect.set(ctx.lease.budget, 'remaining', 999)).toBe(false)
        return {}
      },
      { ...meta, source },
    )
  const { lease: _lease, ...sessionContext } = context()
  expect((await e.dispatch('before_step', () => payload, sessionContext)).kind).toBe('ok')
  expect(seen).toEqual([10, 3])
  expect(second.budget.remaining).toBe(3)
})

it('never falls back to a shared lease when the configured source resolver cannot establish ownership', async () => {
  let called = false
  const e = new HookEngine({ onFailure() {}, diag() {}, leaseFor: () => undefined, platform })
  e.on(
    'before_step',
    () => {
      called = true
      return {}
    },
    meta,
  )
  expect((await e.dispatch('before_step', () => payload, context())).kind).toBe('rejected')
  expect(called).toBe(false)
})

it('allows an empty registry without a fabricated lease but refuses an unowned registered callback', async () => {
  const e = engine(),
    { lease: _lease, ...sessionContext } = context()
  expect((await e.dispatch('before_step', () => payload, sessionContext)).kind).toBe('ok')
  let called = false
  e.on(
    'before_step',
    () => {
      called = true
      return {}
    },
    meta,
  )
  expect((await e.dispatch('before_step', () => payload, sessionContext)).kind).toBe('rejected')
  expect(called).toBe(false)
})
