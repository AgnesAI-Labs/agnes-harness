import {
  type LoopContext,
  type LoopFactory,
  type LoopToolCallOptions,
  loopCheckpointCodec,
} from '@agnes/extension-api'
import { expect, it } from 'vitest'
import { driveLoop } from '../testkit/loop.js'

it('records an announced call or batch as one assistant message and passes the option on', async () => {
  const codec = loopCheckpointCodec(1, (state) => state)
  const create = (ctx: LoopContext) => ({
    cancel() {},
    dispose() {},
    checkpoint: () => codec.encode(null),
    async step(signal: AbortSignal) {
      if (!(await ctx.input.accept())) return { outcome: 'idle' as const }
      await ctx.tools.execute({ name: 'read', args: {} }, signal, { announce: true })
      await ctx.tools.batch(
        [
          { name: 'a', args: {} },
          { name: 'b', args: {} },
        ],
        signal,
        { announce: { content: [{ type: 'text', text: 'both' }] } },
      )
      await ctx.tools.execute({ name: 'plain', args: {} }, signal)
      return ctx.events.finish('completed')
    },
  })
  const factory: LoopFactory = {
    id: 'test.announce',
    version: '1.0.0',
    capabilities: ['tools'],
    codec,
    create,
    resume: create,
  }
  const seen: Array<[string, LoopToolCallOptions | undefined]> = []
  const result = await driveLoop(factory, {
    inputs: [{ content: [{ type: 'text', text: 'go' }] }],
    tools: {
      async execute(call, _signal, options) {
        seen.push([call.name, options])
        return { content: [{ type: 'text', text: call.name }] }
      },
      batch: async () => {
        throw new Error('the testkit runs a batch through execute')
      },
    },
  })
  expect(result.finished).toEqual(['completed'])
  expect(result.events).toEqual([
    { type: 'assistant/message', data: { content: [], stopReason: 'tool_use' } },
    {
      type: 'assistant/message',
      data: { content: [{ type: 'text', text: 'both' }], stopReason: 'tool_use' },
    },
  ])
  const both = { announce: { content: [{ type: 'text', text: 'both' }] } }
  expect(seen).toEqual([
    ['read', { announce: true }],
    ['a', both],
    ['b', both],
    ['plain', undefined],
  ])
})

it('calls the fake tools port with exactly two arguments when no call option is given', async () => {
  const codec = loopCheckpointCodec(1, (state) => state)
  const create = (ctx: LoopContext) => ({
    cancel() {},
    dispose() {},
    checkpoint: () => codec.encode(null),
    async step(signal: AbortSignal) {
      if (!(await ctx.input.accept())) return { outcome: 'idle' as const }
      await ctx.tools.execute({ name: 'plain', args: {} }, signal)
      return ctx.events.finish('completed')
    },
  })
  const factory: LoopFactory = {
    id: 'test.plain-call',
    version: '1.0.0',
    capabilities: ['tools'],
    codec,
    create,
    resume: create,
  }
  const argumentCounts: number[] = []
  await driveLoop(factory, {
    inputs: [{ content: [{ type: 'text', text: 'go' }] }],
    tools: {
      // A rest parameter sees the real arity, so an explicit trailing `undefined` would show up here.
      execute: async (...args: unknown[]) => {
        argumentCounts.push(args.length)
        return { content: [{ type: 'text', text: 'ok' }] }
      },
      batch: async () => {
        throw new Error('the testkit runs a batch through execute')
      },
    },
  })
  expect(argumentCounts).toEqual([2])
})
