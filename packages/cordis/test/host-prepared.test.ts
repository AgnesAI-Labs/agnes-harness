import { describe, expect, it } from 'vitest'
import { Context, type Fiber, FiberState, ValidationError, type Plugin } from '../src/index.js'
import {
  beginPreparedPluginPublication,
  normalizePreparedConfig,
  pluginPrepared,
  preparePluginInvocation,
} from '../src/host.js'

function transformingSchema(onValidate: () => void) {
  return {
    '~standard': {
      version: 1 as const,
      vendor: 'agnes-test',
      validate(value: unknown) {
        onValidate()
        if (typeof value !== 'number') return { issues: [{ message: 'expected number' }] }
        return { value: value + 1 }
      },
    },
  }
}

describe('@agnes/cordis/host prepared invocation', () => {
  it('captures metadata once and applies the author schema exactly once per candidate config', async () => {
    const root = new Context()
    let validations = 0
    const seen: number[] = []
    const plugin: Plugin.Function<number> = function preparedFunction(_ctx, config) {
      seen.push(config)
    }
    plugin.Config = transformingSchema(() => validations++)
    const inject: Record<string, unknown> = {}
    const prepared = preparePluginInvocation(plugin, inject)

    plugin.Config = transformingSchema(() => {
      throw new Error('prepared handle reread mutable Config')
    })
    inject.logger = 'tampered'

    const first = normalizePreparedConfig(prepared, 1)
    expect(first).toBe(2)
    expect(validations).toBe(1)
    const fiber = pluginPrepared(root, prepared, first)
    await fiber
    expect(seen).toEqual([2])
    expect(fiber.inject).toEqual({})

    const second = normalizePreparedConfig(prepared, 4)
    await fiber.update(second)
    expect(validations).toBe(2)
    expect(seen).toEqual([2, 5])
    await fiber.dispose()
  })

  it('preserves function, class, and object execution shapes', async () => {
    const root = new Context()
    const seen: string[] = []
    const fn: Plugin.Function<string> = (_ctx, value) => {
      seen.push(`function:${value}`)
    }
    class ConstructorPlugin {
      constructor(_ctx: Context, value: string) {
        seen.push(`class:${value}`)
      }
    }
    const object: Plugin.Object<string> = {
      apply(_ctx, value) {
        seen.push(`object:${value}`)
      },
    }
    const fibers = [
      pluginPrepared(root, preparePluginInvocation(fn, {}), 'a'),
      pluginPrepared(root, preparePluginInvocation(ConstructorPlugin, {}), 'b'),
      pluginPrepared(root, preparePluginInvocation(object, {}), 'c'),
    ]
    await Promise.all(fibers)
    expect(seen).toEqual(['function:a', 'class:b', 'object:c'])
    await Promise.all(fibers.map((fiber) => fiber.dispose()))
  })

  it('keeps prepared ownership separate from public callback registry ownership', async () => {
    const root = new Context()
    const plugin: Plugin.Function<void> = () => {}
    const prepared = preparePluginInvocation(plugin, {})
    const normal = root.plugin(plugin)
    const first = pluginPrepared(root, prepared, undefined)
    const second = pluginPrepared(root, prepared, undefined)
    await Promise.all([normal, first, second])

    expect(root.registry.size).toBe(1)
    expect(root.registry.has(plugin)).toBe(true)
    expect([...root.registry.keys()]).toEqual([plugin])
    await first.dispose()
    expect(second.uid).not.toBeNull()
    expect(root.registry.has(plugin)).toBe(true)
    await second.dispose()
    expect(root.registry.has(plugin)).toBe(true)
    await normal.dispose()
    expect(root.registry.has(plugin)).toBe(false)
  })

  it('keeps ValidationError semantics for rejected and async schemas', () => {
    const invalid: Plugin.Function<number> = () => {}
    invalid.Config = transformingSchema(() => {})
    const prepared = preparePluginInvocation(invalid, {})
    expect(() => normalizePreparedConfig(prepared, 'bad')).toThrow(ValidationError)

    const asyncPlugin: Plugin.Function<number> = () => {}
    asyncPlugin.Config = {
      '~standard': {
        version: 1,
        vendor: 'agnes-test',
        validate: async (value: unknown) => ({ value: Number(value) }),
      },
    }
    expect(() => normalizePreparedConfig(preparePluginInvocation(asyncPlugin, {}), 1)).toThrow(
      /Async config validation is not supported/,
    )
  })

  it('rejects a forged branded object that has no private prepared record', () => {
    const forged = Object.freeze({})
    expect(() => normalizePreparedConfig(forged as never, 1)).toThrow(/PreparedPluginInvocation/)
  })

  it('rechecks dependencies for prepared fibers without exposing their runtime publicly', async () => {
    const root = new Context()
    const seen: string[] = []
    const plugin: Plugin.Function<void> = (ctx) => {
      seen.push(String((ctx as unknown as { dependency: string }).dependency))
    }
    const fiber = pluginPrepared(root, preparePluginInvocation(plugin, { dependency: null }), undefined)
    expect(fiber.state).toBe(FiberState.PENDING)
    expect(root.registry.size).toBe(0)
    const release = root.provide('dependency', 'ready')
    await fiber
    expect(seen).toEqual(['ready'])
    expect(root.registry.size).toBe(0)
    await fiber.dispose()
    await release()
  })

  it('preserves ordinary ctx.plugin schema, registry, and cleanup behavior', async () => {
    const root = new Context()
    let validations = 0
    const seen: number[] = []
    const plugin: Plugin.Function<number> = (_ctx, config) => {
      seen.push(config)
    }
    plugin.Config = transformingSchema(() => validations++)
    const fiber = root.plugin(plugin, 2)
    await fiber
    expect(validations).toBe(1)
    expect(seen).toEqual([3])
    expect(root.registry.get(plugin)?.fibers.length).toBe(1)
    await fiber.dispose()
    expect(root.registry.has(plugin)).toBe(false)
  })
})

describe('prepared publication batch', () => {
  it('attests before lifecycle preflight and publishes parent extras before child activation', async () => {
    const root = new Context()
    const order: string[] = []
    root.on('internal/plugin', (fiber) => {
      if (fiber.uid !== null) order.push(`event:${fiber.name}`)
    })
    const wrapperPlugin: Plugin.Function<void> = function wrapper() {
      order.push('apply:wrapper')
    }
    const childPlugin: Plugin.Function<void> = function child(ctx) {
      order.push(`apply:child:${String((ctx as unknown as { exact: string }).exact)}`)
    }
    const batch = beginPreparedPluginPublication()
    const wrapper = batch.plugin(root, preparePluginInvocation(wrapperPlugin, {}), undefined, () =>
      order.push('attest:wrapper'),
    )
    wrapper.ctx.provide('exact', 'value')
    const child = batch.plugin(
      wrapper.ctx,
      preparePluginInvocation(childPlugin, { exact: null }),
      undefined,
      () => order.push('attest:child'),
    )

    expect(root.reflect.get('exact', false)).toBeUndefined()
    expect(wrapper.state).toBe(FiberState.PENDING)
    expect(child.state).toBe(FiberState.PENDING)
    expect(order).toEqual(['attest:wrapper', 'attest:child'])
    const published = batch.publish()
    await Promise.all(published)
    expect(order).toEqual([
      'attest:wrapper',
      'attest:child',
      'event:wrapper',
      'event:child',
      'apply:wrapper',
      'apply:child:value',
    ])
    expect(root.reflect.get('exact')).toBe('value')
    await wrapper.dispose()
    expect(root.reflect.get('exact', false)).toBeUndefined()
  })

  it('runs the continuous provide gate before pending or live store writes', async () => {
    const root = new Context()
    const seen: string[] = []
    root.on('internal/provide', function (name, value, next) {
      seen.push(`${this.fiber.name}:${name}:${String(value)}`)
      if (name === 'blocked') throw new Error('blocked by provide gate')
      return next()
    })
    const plugin: Plugin.Function<void> = function wrapper() {}
    const batch = beginPreparedPluginPublication()
    const wrapper = batch.plugin(root, preparePluginInvocation(plugin, {}), undefined)
    expect(() => wrapper.ctx.provide('blocked', 1)).toThrow('blocked by provide gate')
    wrapper.ctx.provide('allowed', 2)
    expect(root.reflect.get('allowed', false)).toBeUndefined()
    await Promise.all(batch.publish())
    expect(root.reflect.get('allowed', false)).toBe(2)
    expect(() => wrapper.ctx.provide('blocked', 3)).toThrow('blocked by provide gate')
    expect(root.reflect.get('blocked', false)).toBeUndefined()
    expect(seen).toEqual(['wrapper:blocked:1', 'wrapper:allowed:2', 'wrapper:blocked:3'])
    await wrapper.dispose()
  })

  it('rolls back unpublished effects, stores, runtimes, and fibers', async () => {
    const root = new Context()
    const initialEffects = root.fiber.getEffects().length
    const plugin: Plugin.Function<void> = function rollbackOnly() {
      throw new Error('must not execute before publication')
    }
    const batch = beginPreparedPluginPublication()
    const fiber = batch.plugin(root, preparePluginInvocation(plugin, {}), undefined)
    fiber.ctx.provide('pending', 'value')
    await batch.rollback()
    expect(fiber.uid).toBeNull()
    expect(root.reflect.get('pending', false)).toBeUndefined()
    expect(root.fiber.getEffects()).toHaveLength(initialEffects)
    expect(root.registry.size).toBe(0)
  })

  it('rolls back when a prepublication attestation throws', () => {
    const root = new Context()
    const batch = beginPreparedPluginPublication()
    const plugin: Plugin.Function<void> = () => {}
    expect(() =>
      batch.plugin(root, preparePluginInvocation(plugin, {}), undefined, () => {
        throw new Error('attestation failed')
      }),
    ).toThrow('attestation failed')
    expect(root.registry.size).toBe(0)
    expect(root.fiber.getEffects()).toEqual([])
  })

  it('lets callers await complete cleanup after publication event failure', async () => {
    const root = new Context()
    const initialEffects = root.fiber.getEffects().length
    root.on('internal/plugin', (fiber) => {
      if (fiber.uid !== null && fiber.name === 'child') throw new Error('publication rejected')
    })
    const gateEffects = root.fiber.getEffects().length
    const batch = beginPreparedPluginPublication()
    const wrapperPlugin: Plugin.Function<void> = function wrapper() {}
    const childPlugin: Plugin.Function<void> = function child() {}
    const wrapper = batch.plugin(root, preparePluginInvocation(wrapperPlugin, {}), undefined)
    wrapper.ctx.provide('pending-extra', true)
    batch.plugin(wrapper.ctx, preparePluginInvocation(childPlugin, {}), undefined)

    expect(() => batch.publish()).toThrow('publication rejected')
    await batch.rollback()

    expect(root.reflect.get('pending-extra', false)).toBeUndefined()
    expect(root.reflect.props['pending-extra']).toBeUndefined()
    expect(Object.hasOwn(root[Context.isolate], 'pending-extra')).toBe(false)
    expect(root.registry.size).toBe(0)
    expect(root.fiber.getEffects()).toHaveLength(gateEffects)
    expect(gateEffects).toBe(initialEffects + 1)
  })

  it('rejects publication when a lifecycle observer synchronously disposes a staged fiber', async () => {
    const root = new Context()
    const initialEffects = root.fiber.getEffects().length
    root.on('internal/plugin', (fiber) => {
      if (fiber.uid !== null && fiber.name === 'disposedByObserver') void fiber.dispose()
    })
    const observerEffects = root.fiber.getEffects().length
    const plugin: Plugin.Function<void> = function disposedByObserver() {}
    const batch = beginPreparedPluginPublication()
    const fiber = batch.plugin(root, preparePluginInvocation(plugin, {}), undefined)

    expect(() => batch.publish()).toThrow(/disposed prepared fiber/)
    await batch.rollback()

    expect(fiber.uid).toBeNull()
    expect(root.registry.size).toBe(0)
    expect(root.fiber.getEffects()).toHaveLength(observerEffects)
    expect(observerEffects).toBe(initialEffects + 1)
  })

  it('withdraws an announced fiber when a later lifecycle observer rejects publication', async () => {
    const root = new Context()
    const visible = new Set<Fiber>()
    root.on('internal/plugin', (fiber) => {
      if (fiber.uid === null) visible.delete(fiber)
      else visible.add(fiber)
    })
    root.on('internal/plugin', (fiber) => {
      if (fiber.uid !== null && fiber.name === 'rejectedAfterObservation') {
        throw new Error('publication rejected after observation')
      }
    })
    const observerEffects = root.fiber.getEffects().length
    const plugin: Plugin.Function<void> = function rejectedAfterObservation() {}
    const batch = beginPreparedPluginPublication()
    const fiber = batch.plugin(root, preparePluginInvocation(plugin, {}), undefined)

    expect(() => batch.publish()).toThrow('publication rejected after observation')
    await batch.rollback()

    expect(fiber.uid).toBeNull()
    expect(visible.size).toBe(0)
    expect(root.registry.size).toBe(0)
    expect(root.fiber.getEffects()).toHaveLength(observerEffects)
  })

  it('rolls back all pending provides synchronously when batch commit conflicts', async () => {
    const root = new Context()
    const plugin: Plugin.Function<void> = () => {}
    const prepared = preparePluginInvocation(plugin, {})
    const batch = beginPreparedPluginPublication()
    const first = batch.plugin(root, prepared, undefined)
    const second = batch.plugin(root, prepared, undefined)
    first.ctx.provide('duplicate', 'first')
    second.ctx.provide('duplicate', 'second')
    expect(() => batch.publish()).toThrow(/service "duplicate" has been registered/)
    expect(root.reflect.get('duplicate', false)).toBeUndefined()
    expect(root.reflect.props.duplicate).toBeUndefined()
    expect(Object.hasOwn(root[Context.isolate], 'duplicate')).toBe(false)
    expect(root.registry.size).toBe(0)
    await batch.rollback()
    expect(root.fiber.getEffects()).toEqual([])
  })

  it('rejects a disposed staged fiber before attaching any batch member', async () => {
    const root = new Context()
    const batch = beginPreparedPluginPublication()
    const prepared = preparePluginInvocation(() => {}, {})
    batch.plugin(root, prepared, undefined)
    const disposed = batch.plugin(root, prepared, undefined)
    await disposed.dispose()
    expect(() => batch.publish()).toThrow(/disposed prepared fiber/)
    expect(root.fiber.getEffects()).toEqual([])
    expect(root.registry.size).toBe(0)
  })
})
