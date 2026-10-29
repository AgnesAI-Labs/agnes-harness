import { describe, expect, it } from 'vitest'
import { Context, type Fiber, FiberState, type Plugin } from '../src/index.js'

describe('public plugin lifecycle', () => {
  it('keeps the replacement runtime when an old disposal observer reloads the same callback', async () => {
    const root = new Context()
    const plugin: Plugin.Function<void> = () => {}
    const old = await root.plugin(plugin)
    let replacement: (Fiber & PromiseLike<Fiber>) | undefined
    root.on('internal/plugin', fiber => {
      if (fiber === old && fiber.uid === null) replacement = root.plugin(plugin)
    })
    root.registry.delete(plugin)
    await old.dispose()
    expect(replacement).toBeDefined()
    await replacement
    expect(replacement?.state).toBe(FiberState.ACTIVE)
    expect(replacement?.uid).not.toBeNull()
    expect(root.registry.get(plugin)?.fibers.length).toBe(1)
    await replacement?.dispose()
    expect(root.registry.has(plugin)).toBe(false)
  })

  it('refuses to report circular waiting dependencies as successful startup and can later activate', async () => {
    const root = new Context()
    const active: string[] = []
    const first = root.plugin({ inject: ['cycleB'], apply(ctx) {
      active.push('a')
      ctx.provide('cycleA', true)
    } })
    const second = root.plugin({ inject: ['cycleA'], apply(ctx) {
      active.push('b')
      ctx.provide('cycleB', true)
    } })
    expect(active).toEqual([])
    await expect(Promise.resolve(first).then(() => 'loaded')).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' })
    await expect(Promise.resolve(second).then(() => 'loaded')).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' })
    expect(first.state).toBe(FiberState.PENDING)
    await Promise.all([first.dispose(), second.dispose()])
    const waiting = root.plugin({ inject: ['later'], apply() { active.push('later') } })
    await expect(Promise.resolve(waiting).then(() => 'loaded')).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' })
    const seed = root.provide('later', true)
    await waiting
    expect(active).toEqual(['later'])
    await waiting.dispose()
    await seed()
  })

  it('removes only the exporter owned by the disposed registration', async () => {
    const root = new Context()
    const messages: string[] = []
    const first = root.logger.exporter({ export: message => { messages.push(`a:${message.args[0]}`) } })
    const second = root.logger.exporter({ export: message => { messages.push(`b:${message.args[0]}`) } })
    await first()
    root.logger.info('after-a')
    expect(messages).toEqual(['b:after-a'])
    await second()
    root.logger.info('after-b')
    expect(messages).toEqual(['b:after-a'])
    expect(root.logger.buffer.map(message => message.args[0])).toEqual(['after-a', 'after-b'])
  })
})

it('keeps optional dependencies usable before registration and after disposal', async () => {
  const root = new Context()
  const seen: unknown[] = []
  const dependent = root.plugin({ inject: { optionalState: { required: false } }, apply(ctx: Context) {
    seen.push((ctx as Context & { optionalState?: string }).optionalState)
  } })
  await dependent
  expect(seen).toEqual([undefined])
  const release = root.provide('optionalState', 'ready')
  await expect.poll(() => seen.at(-1)).toBe('ready')
  await release()
  await expect.poll(() => seen).toEqual([undefined, 'ready', undefined])
  expect(dependent.state).toBe(FiberState.ACTIVE)
  await root.fiber.dispose()
})
