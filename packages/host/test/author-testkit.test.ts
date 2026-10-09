import { describe, expect, it } from 'vitest'
import type { Context, LoopPluginContext } from '@agnes/plugin-runtime'
import { defineAgnesPlugin, defineLoop } from '@agnes/plugin-runtime'
import { loopCheckpointCodec } from '@agnes/extension-api'
import { createAuthorTestkit, createPluginTestHost } from '@agnes/host/author-testkit'
import { fixtureTool } from './fixtures/tool.js'

function plugin(version: string, approval = false, wait?: () => Promise<void>) {
  return defineAgnesPlugin({
    inject: ['extension'],
    apply(ctx: Context) {
      ctx.extension().registerTool({
        ...fixtureTool('version'),
        meta: { ...fixtureTool('version').meta, requiresApproval: approval ? 'always' : 'never' },
        async execute() {
          await wait?.()
          return { content: [{ type: 'text', text: version }], structured: { version } }
        },
      })
    },
  })
}

describe('public author testkit', () => {
  it('mounts the lightweight tool fixture with one import and real registration', async () => {
    const fixture = await createPluginTestHost(plugin('1'))
    try {
      expect((await fixture.invoke('version', {})).structured).toEqual({ version: '1' })
    } finally {
      await fixture.dispose()
    }
    expect(fixture.tools.size).toBe(0)
  })

  it('records Core approvals and refusal without an effect, then permits the approved action', async () => {
    for (const verdict of ['rejected', 'allowed-once'] as const) {
      const kit = await createAuthorTestkit({
        plugin: plugin('1', true),
        version: '1.0.0',
        approval: async () => verdict,
      })
      try {
        const session = await kit.openSession()
        const result = await session.invoke('version', {})
        await session.assertApproval(verdict)
        if (verdict === 'rejected') {
          expect(result.isError).toBe(true)
          await session.assertRefused('version')
          expect(await session.effects()).toEqual([])
        } else {
          expect(result.structured).toEqual({ version: '1' })
          expect((await session.effects()).map((event) => event.type)).toContain('effect/settled')
        }
        expect((await session.facts()).some((event) => event.type === 'tool/result')).toBe(true)
      } finally {
        await kit.dispose()
      }
    }
  })

  it('keeps an in-flight session on its pinned generation while new sessions adopt a reload', async () => {
    let entered!: () => void, release!: () => void
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const kit = await createAuthorTestkit({
      plugin: plugin('1', false, async () => {
        entered()
        await held
      }),
      version: '1.0.0',
    })
    try {
      const old = await kit.openSession()
      const pin = old.generation!
      const pending = old.invoke('version', {})
      await ready
      const generation = await kit.reload({ plugin: plugin('2'), version: '2.0.0' })
      release()
      expect((await pending).structured).toEqual({ version: '1' })
      old.assertPinned(pin)
      expect((await old.invoke('version', {})).structured).toEqual({ version: '1' })
      const fresh = await kit.openSession()
      fresh.assertPinned(generation)
      expect(generation).not.toBe(pin)
      expect((await fresh.invoke('version', {})).structured).toEqual({ version: '2' })
      await expect(kit.reload({ plugin: plugin('3'), version: '2.0.0' })).rejects.toThrow('new')
    } finally {
      release()
      await kit.dispose()
    }
    await expect(kit.openSession()).rejects.toThrow('disposed')
    await kit.dispose()
  })

  it('drives a registered independent Loop for bounded steps and persists its facts', async () => {
    const codec = loopCheckpointCodec(1, (state) => state)
    const loop = defineLoop({
      id: 'author.counter',
      version: '1.0.0',
      capabilities: [],
      codec,
      create(ctx) {
        let count = 0
        return {
          async step() {
            await ctx.input.accept()
            await ctx.checkpoints.write(codec.encode(++count))
            if (count === 3) {
              await ctx.events.finish('completed')
              return { outcome: 'turn-ended', phase: 'done', reason: 'completed' }
            }
            return { outcome: 'running', phase: 'counting' }
          },
          checkpoint: () => codec.encode(count),
          cancel() {},
          dispose() {},
        }
      },
      resume() {
        throw new Error('Not used')
      },
    })
    const kit = await createAuthorTestkit({
      version: '1.0.0',
      loop,
      plugin: {
        inject: ['loops'],
        apply(ctx: LoopPluginContext) {
          ctx.effect(() => ctx.loops.register('@author/plugin', loop))
        },
      },
    })
    try {
      const session = await kit.openSession()
      await session.enqueue('count')
      expect(await session.drive(2)).toHaveLength(2)
      expect(await session.drive(9)).toHaveLength(1)
      expect((await session.facts()).filter((event) => event.type === 'x/core/loop-checkpoint')).toHaveLength(
        3,
      )
      await expect(session.drive(0)).rejects.toThrow('positive')
      await expect(session.invoke('version', {})).rejects.toThrow('separate session')
    } finally {
      await kit.dispose()
    }
  })
})
