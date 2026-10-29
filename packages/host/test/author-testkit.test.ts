import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type LoopSideCallPort,
  loopCheckpointCodec,
  loopKind,
  type PreparedSideCall,
  type SideCallResult,
} from '@agnes/extension-api'
import {
  createAuthorTestkit,
  createPluginTestHost,
  driveLoop,
  fakeModel,
  recordModelFixture,
  replayModelFixture,
  ScriptedProvider,
} from '@agnes/host/author-testkit'
import type { Context, ProviderPluginContext } from '@agnes/plugin-runtime'
import { defineAgnesPlugin, defineLoop } from '@agnes/plugin-runtime'
import { describe, expect, it } from 'vitest'
import { fixtureTool } from './fixtures/tool.js'

function plugin(version: string, approval = false, wait?: (signal: AbortSignal) => Promise<void>) {
  return defineAgnesPlugin({
    inject: ['tools'],
    apply(ctx: Context) {
      ctx.tools.register({
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
  it('boots with declared capabilities when the git-worktree registrar has no plugin row', async () => {
    const kit = await createAuthorTestkit({
      plugin: defineAgnesPlugin({
        inject: ['tools'],
        apply(ctx: Context) {
          ctx.tools.register({
            ...fixtureTool('owned_value'),
            meta: {
              ...fixtureTool('owned_value').meta,
              isReadOnly: false,
              isConcurrencySafe: false,
              replay: 'never',
            },
            async execute(_args, call) {
              if (!call.store) throw new Error('Declared store missing')
              const value = Number(call.store.get('value') ?? 0) + 1
              call.store.set('value', value)
              return { content: [{ type: 'text', text: String(value) }], structured: { value } }
            },
          })
        },
      }),
      version: '1.0.0',
      capabilities: { uiData: ['author.test'], store: true } as const,
    })
    try {
      const session = await kit.openSession()
      expect((await session.invoke('owned_value', {})).structured).toEqual({ value: 1 })
      const next = await kit.openSession()
      expect((await next.invoke('owned_value', {})).structured).toEqual({ value: 2 })
    } finally {
      await kit.dispose()
    }
  })

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
        approval: async () => ({
          verdict,
          answeredBy: { id: 'reviewer', org: 'local', role: 'owner', deptPath: [], attrs: {} },
        }),
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
      inject: ['providers', 'skills'],
      apply(ctx: Context) {
        ctx.skills.register({
          name: 'author-model',
          description: 'Synthetic model instructions',
          body: 'Offline business fixture',
        })
        ctx.providers.registerHost(loopKind, '@author/plugin', loop)
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
        inject: ['providers'],
        apply(ctx: Context) {
          ctx.providers.registerHost(loopKind, '@author/plugin', loop)
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

  it('hands a supplied side-call port to a driven loop and leaves it absent otherwise', async () => {
    const codec = loopCheckpointCodec(1, (state) => state)
    const loop = defineLoop({
      id: 'author.side-call',
      version: '1.0.0',
      capabilities: [],
      codec,
      create(ctx) {
        return {
          async step(signal) {
            await ctx.input.accept()
            const port = ctx.sideCall
            if (!port) await ctx.events.emit('side-call', { present: false })
            else {
              const prepared = await port.prepare({
                label: 'author.check',
                target: { route: 'side-route', model: 'side-model' },
                payload: { question: 'next move' },
                invocationId: 'check-1',
              })
              const result = await port.invoke(prepared, signal)
              await ctx.events.emit('side-call', {
                present: true,
                status: result.status,
                text: result.status === 'ok' ? result.text : null,
                again: (await port.status('check-1')).status,
              })
            }
            await ctx.checkpoints.write(codec.encode(null))
            await ctx.events.finish('completed')
            return { outcome: 'turn-ended', phase: 'done', reason: 'completed' }
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
    const calls: unknown[] = []
    const sideCall: LoopSideCallPort = {
      async prepare(options) {
        calls.push(['prepare', options])
        return { invocationId: options.invocationId ?? 'generated', requestHash: 'h' } as PreparedSideCall
      },
      async invoke(prepared, signal) {
        calls.push(['invoke', prepared.invocationId, signal.aborted])
        return {
          status: 'ok',
          invocationId: prepared.invocationId,
          text: 'yes',
          usage: {
            tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            credits: 0,
            creditSource: 'estimated',
          },
          latencyMs: 1,
          replayed: false,
        } satisfies SideCallResult
      },
      async status(invocationId) {
        calls.push(['status', invocationId])
        return { status: 'absent', invocationId }
      },
    }
    const inputs = [{ content: [{ type: 'text' as const, text: 'decide' }] }]
    const supplied = await driveLoop(loop, { inputs, sideCall })
    expect(supplied.events).toContainEqual({
      type: 'side-call',
      data: { present: true, status: 'ok', text: 'yes', again: 'absent' },
    })
    expect(calls).toEqual([
      ['prepare', expect.objectContaining({ label: 'author.check', payload: { question: 'next move' } })],
      ['invoke', 'check-1', false],
      ['status', 'check-1'],
    ])
    const plain = await driveLoop(loop, { inputs })
    expect(plain.events).toContainEqual({ type: 'side-call', data: { present: false } })
  })
})
