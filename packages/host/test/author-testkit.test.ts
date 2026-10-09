import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loopCheckpointCodec } from '@agnes/extension-api'
import {
  createAuthorTestkit,
  createPluginTestHost,
  fakeModel,
  recordModelFixture,
  replayModelFixture,
  ScriptedProvider,
} from '@agnes/host/author-testkit'
import type { Context, LoopPluginContext } from '@agnes/plugin-runtime'
import { defineAgnesPlugin, defineLoop } from '@agnes/plugin-runtime'
import { describe, expect, it } from 'vitest'
import { fixtureTool } from './fixtures/tool.js'

function plugin(version: string, approval = false, wait?: (signal: AbortSignal) => Promise<void>) {
  return defineAgnesPlugin({
    inject: ['extension'],
    apply(ctx: Context) {
      ctx.extension().registerTool({
        ...fixtureTool('version'),
        meta: { ...fixtureTool('version').meta, requiresApproval: approval ? 'always' : 'never' },
        async execute(_args, ctx) {
          await wait?.(ctx.signal)
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

  it.each(['standard', 'author'])(
    'keeps an in-flight session on its pinned generation while new sessions adopt a reload (%s)',
    async (preset) => {
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
        preset,
        presets: { author: { name: 'author', extends: 'standard' } },
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
        await expect(
          kit.reload({
            plugin: {
              apply() {
                throw new Error('Broken candidate')
              },
            },
            version: '3.0.0',
          }),
        ).rejects.toThrow()
        const retained = await kit.openSession()
        retained.assertPinned(generation)
        expect((await retained.invoke('version', {})).structured).toEqual({ version: '2' })
      } finally {
        release()
        await kit.dispose()
      }
      await expect(kit.openSession()).rejects.toThrow('disposed')
      await kit.dispose()
    },
  )

  it('drains a cancelled invocation and permits another turn on the pinned session', async () => {
    let entered!: () => void
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    let first = true
    const kit = await createAuthorTestkit({
      version: '1.0.0',
      plugin: plugin('1', false, async (signal) => {
        if (!first) return
        first = false
        entered()
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          if (signal.aborted) reject(signal.reason)
        })
      }),
    })
    try {
      const session = await kit.openSession()
      const pin = session.generation!
      const controller = new AbortController()
      const pending = session.invoke('version', {}, controller.signal)
      const stopped = expect(pending).rejects.toThrow()
      await ready
      controller.abort(new Error('Stopped by author'))
      await stopped
      expect((await session.invoke('version', {})).structured).toEqual({ version: '1' })
      session.assertPinned(pin)
    } finally {
      await kit.dispose()
    }
  })

  it('records and replays a business Loop through Host with a supplied model catalogue', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agh-author-model-'))
    const file = join(directory, 'model.json')
    const codec = loopCheckpointCodec(1, (state) => state)
    const loop = defineLoop({
      id: 'author.model',
      version: '1.0.0',
      capabilities: ['model'],
      codec,
      create(ctx) {
        return {
          async step(signal) {
            if (!(await ctx.input.accept())) return { outcome: 'idle' }
            const request = await ctx.prepareRequest({
              system: 'synthetic-model-test',
              messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
            })
            const events = await ctx.model.complete(request, signal)
            expect(events).toContainEqual({ type: 'text_delta', delta: 'offline answer' })
            await ctx.checkpoints.write(codec.encode(null))
            await ctx.events.finish('completed')
            return { outcome: 'turn-ended', reason: 'completed' }
          },
          checkpoint: () => codec.encode(null),
          cancel() {},
          dispose() {},
        }
      },
      resume() {
        throw new Error('Not used')
      },
    })
    const main = {
      inject: ['loops', 'skills'],
      apply(ctx: LoopPluginContext) {
        ctx.skills.register({
          name: 'author-model',
          description: 'Synthetic model instructions',
          body: 'Offline business fixture',
        })
        ctx.effect(() => ctx.loops.register('@author/plugin', loop))
      },
    }
    try {
      const recorder = await recordModelFixture(
        new ScriptedProvider({
          models: [fakeModel({ id: 'recorded-model', route: 'recorded-route' })],
          scripts: [
            [
              { type: 'text_delta', delta: 'offline answer' },
              { type: 'done', reason: 'stop' },
            ],
          ],
          onExhausted: 'error',
        }),
        file,
      )
      try {
        const kit = await createAuthorTestkit({
          plugin: main,
          version: '1.0.0',
          loop,
          provider: recorder.provider,
        })
        try {
          const session = await kit.openSession()
          await session.enqueue('hello')
          expect(await session.drive(1)).toHaveLength(1)
        } finally {
          await kit.dispose()
        }
      } finally {
        await recorder.close()
      }
      const replay = await replayModelFixture(file)
      const kit = await createAuthorTestkit({
        plugin: main,
        version: '1.0.0',
        loop,
        provider: replay.provider,
      })
      try {
        const session = await kit.openSession()
        await session.enqueue('hello')
        expect(await session.drive(1)).toHaveLength(1)
        replay.assertConsumed()
      } finally {
        await kit.dispose()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
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
        4,
      )
      await expect(session.drive(0)).rejects.toThrow('positive')
      await expect(session.invoke('version', {})).rejects.toThrow('separate session')
    } finally {
      await kit.dispose()
    }
  })
})
