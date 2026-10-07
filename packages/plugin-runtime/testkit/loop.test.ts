import { type LoopContext, type LoopDriver, loopCheckpointCodec } from '@agnes/extension-api'
import { Type } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import { type Context, defineLoop, defineTool } from '../src/index.js'
import { driveLoop } from './loop.js'
import { createPluginTestHost } from './plugin.js'

const codec = loopCheckpointCodec(1, (state) => {
  if (typeof state !== 'number') throw new TypeError('Expected numeric state')
  return state
})
const request = {
  kind: 'inference' as const,
  sessionKey: 'test',
  slot: 'primary' as const,
  route: 'demo',
  model: 'demo',
  contractId: null,
  derivedHash: '0'.repeat(64),
  system: 'test',
  messages: [],
  tools: [],
}

describe('loop author driver', () => {
  it('drives scripted model replies into a real Host-registered tool and resumes a checkpoint', async () => {
    const tool = defineTool({
      name: 'loop_echo',
      description: 'Echo a value.',
      parameters: Type.Object({ text: Type.String() }),
      result: Type.Object({ text: Type.String() }),
      meta: {
        isReadOnly: true,
        isDestructive: false,
        isConcurrencySafe: true,
        isOpenWorld: false,
        replay: 'safe',
        costHint: undefined,
        deferLoading: undefined,
        requiresApproval: 'never',
      },
      async execute(args) {
        return { content: [], structured: args }
      },
    })
    const host = await createPluginTestHost({
      inject: ['extension'],
      apply(ctx: Context) {
        ctx.extension().registerTool(tool)
      },
    })
    let disposed = false
    const create = (ctx: LoopContext, initial = 0): LoopDriver => {
      let state = initial
      return {
        async step(signal) {
          if (state) return { outcome: 'turn-ended', phase: 'done', reason: 'completed' }
          const reply = await ctx.model.complete(request, signal)
          for (const event of reply)
            if (event.type === 'toolcall_end') {
              const result = await ctx.tools.execute({ name: event.call.name, args: event.call.args }, signal)
              await ctx.events.emit('result', result.structured as { text: string })
            }
          state++
          await ctx.checkpoints.write(codec.encode(state))
          await ctx.events.finish('completed')
          return { outcome: 'turn-ended', phase: 'done', reason: 'completed' }
        },
        cancel() {},
        dispose() {
          disposed = true
        },
        checkpoint: () => codec.encode(state),
      }
    }
    const loop = defineLoop({
      id: 'test',
      version: '1.0.0',
      capabilities: ['model', 'tools'],
      codec,
      create,
      resume: (ctx: LoopContext, checkpoint: ReturnType<typeof codec.encode>) =>
        create(ctx, codec.decode(checkpoint)),
    })
    expect(defineLoop(loop)).toBe(loop)
    try {
      const result = await driveLoop(loop, {
        replies: [
          [
            {
              type: 'toolcall_end',
              via: 'native',
              call: { toolUseId: 'call', ordinal: 0, name: 'loop_echo', args: { text: 'hello' } },
            },
          ],
        ],
        tools: {
          execute: (call, signal) => host.invoke(call.name, call.args, signal),
          batch: (calls, signal) =>
            Promise.all(calls.map((call) => host.invoke(call.name, call.args, signal))),
        },
      })
      expect(result.events).toEqual([{ type: 'result', data: { text: 'hello' } }])
      expect(result.checkpoint).toEqual({ codecVersion: 1, state: 1 })
      expect(result.remainingReplies).toBe(0)
      expect(disposed).toBe(true)
      expect((await driveLoop(loop, { checkpoint: result.checkpoint })).requests).toEqual([])
      await expect(driveLoop(loop, { checkpoint: { codecVersion: 2, state: 1 } })).rejects.toThrow(
        'unsupported',
      )
      disposed = false
      await expect(driveLoop(loop)).rejects.toThrow('exhausted')
      expect(disposed).toBe(true)
    } finally {
      await host.dispose()
    }
  })

  it('bounds unfinished drivers and cleans up cancellation', async () => {
    let disposed = false
    let cancelled = false
    const ac = new AbortController()
    const loop = defineLoop({
      id: 'test',
      version: '1.0.0',
      capabilities: [],
      codec,
      create: () => ({
        step: async () => ({ outcome: 'running', phase: 'working' }),
        cancel() {
          cancelled = true
        },
        dispose() {
          disposed = true
        },
        checkpoint: () => codec.encode(0),
      }),
      resume: () => {
        throw new Error('Not used')
      },
    })
    await expect(driveLoop(loop, { maxSteps: 2 })).rejects.toThrow('exceeded 2')
    expect(disposed).toBe(true)
    disposed = false
    const aborting = defineLoop({
      ...loop,
      create: () => ({
        ...loop.create(),
        async step() {
          ac.abort(new Error('Stopped'))
          return { outcome: 'running', phase: 'working' }
        },
      }),
    })
    await expect(driveLoop(aborting, { signal: ac.signal })).rejects.toThrow('Stopped')
    expect(cancelled).toBe(true)
    expect(disposed).toBe(true)
  })
})
