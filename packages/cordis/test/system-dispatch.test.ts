import { describe, expect, it } from 'vitest'
import { Context } from '../src/index.js'

declare module '../src/events.js' {
  interface Events {
    'internal/probe'(this: Context, value: number, next?: () => string): string | void
  }
}

interface DispatchObservation {
  args: unknown[]
  explicitThisArg: unknown
  mode: string
  name: string
  source: Context
  system: boolean
}

describe('internal dispatch provenance', () => {
  it('reports the source and an unforgeable non-system marker for all public modes', async () => {
    const root = new Context()
    const observations: DispatchObservation[] = []
    root.on('internal/dispatch', function (mode, name, args, explicitThisArg, system) {
      observations.push({
        args,
        explicitThisArg,
        mode,
        name,
        source: this,
        system,
      })
    })
    const fiber = root.plugin(() => {})
    await fiber
    observations.length = 0

    fiber.ctx.emit('internal/probe', 1)
    await fiber.ctx.parallel('internal/probe', 2)
    await fiber.ctx.serial('internal/probe', 3)
    fiber.ctx.bail('internal/probe', 4)
    fiber.ctx.waterfall('internal/probe', 5, () => 'done')

    expect(observations.map(({ mode, name, source, system }) => ({ mode, name, source, system }))).toEqual([
      { mode: 'emit', name: 'internal/probe', source: fiber.ctx, system: false },
      { mode: 'parallel', name: 'internal/probe', source: fiber.ctx, system: false },
      { mode: 'serial', name: 'internal/probe', source: fiber.ctx, system: false },
      { mode: 'bail', name: 'internal/probe', source: fiber.ctx, system: false },
      { mode: 'waterfall', name: 'internal/probe', source: fiber.ctx, system: false },
    ])
    expect(observations.map(({ args }) => args[0])).toEqual([1, 2, 3, 4, 5])
    expect(observations.every(({ explicitThisArg }) => explicitThisArg === null)).toBe(true)
  })

  it('preserves source context for extracted methods and explicit listener this', async () => {
    const root = new Context()
    const observations: DispatchObservation[] = []
    root.on('internal/dispatch', function (mode, name, args, explicitThisArg, system) {
      observations.push({ args, explicitThisArg, mode, name, source: this, system })
    })
    const fiber = root.plugin(() => {})
    await fiber
    observations.length = 0
    const emit = fiber.ctx.emit
    const explicitThisArg = fiber.ctx.extend({ marker: true })

    emit(explicitThisArg, 'internal/probe', 6)

    expect(observations).toHaveLength(1)
    expect(observations[0]?.args).toEqual([6])
    expect(observations[0]?.explicitThisArg).toBe(explicitThisArg)
    expect(observations[0]?.mode).toBe('emit')
    expect(observations[0]?.name).toBe('internal/probe')
    expect(observations[0]?.source).toBe(fiber.ctx)
    expect(observations[0]?.system).toBe(false)
  })

  it('marks framework lifecycle dispatches as system without exposing the token', async () => {
    const root = new Context()
    const observations: DispatchObservation[] = []
    root.on('internal/dispatch', function (mode, name, args, explicitThisArg, system) {
      observations.push({ args, explicitThisArg, mode, name, source: this, system })
    })
    const fiber = root.plugin((ctx) => {
      ctx.provide('prepared-service', true)
    })
    await fiber

    expect(
      observations.some(
        ({ name, source, system }) => name === 'internal/plugin' && source === fiber.ctx && system,
      ),
    ).toBe(true)
    expect(
      observations.some(
        ({ name, source, system }) => name === 'internal/provide' && source === fiber.ctx && system,
      ),
    ).toBe(true)
    expect(
      Reflect.ownKeys(Object.getPrototypeOf(root.events)).some(
        (key) => typeof key === 'symbol' && key.description === 'cordis.system-dispatch',
      ),
    ).toBe(false)
  })

  it('routes a public internal/dispatch attempt through the gate once', () => {
    const root = new Context()
    const observations: DispatchObservation[] = []
    root.on('internal/dispatch', function (mode, name, args, explicitThisArg, system) {
      observations.push({ args, explicitThisArg, mode, name, source: this, system })
    })
    observations.length = 0

    const untypedEmit = root.emit as (...args: unknown[]) => void
    untypedEmit('internal/dispatch', 'forged', 'event', [], null, true)

    expect(observations).toHaveLength(1)
    expect(observations[0]?.mode).toBe('emit')
    expect(observations[0]?.name).toBe('internal/dispatch')
    expect(observations[0]?.source).toBe(root)
    expect(observations[0]?.system).toBe(false)
  })
})
