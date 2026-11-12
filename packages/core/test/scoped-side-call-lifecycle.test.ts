import { presetDefaults } from '@agnes/core-common/step/preset'
import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import {
  type LoopContext,
  type LoopFactory,
  loopCheckpointCodec,
  type SideCallResult,
} from '@agnes/extension-api'
import { expect, it } from 'vitest'
import { SessionHookPort } from '../src/hooks/port.js'
import { Kernel } from '../src/kernel.js'
import { defaultLoops } from '../testkit/loops.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, noTimers, testFsOps, testWorkspaceInvocation } from './helpers/open-session.js'
import {
  answer,
  data,
  gated,
  never,
  options,
  type SideScript,
  sideCosts,
  sideProvider,
} from './helpers/side-call-session.js'

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected fixture value')
  return value
}

const codec = loopCheckpointCodec(1, () => null)
const driver = (ctx: LoopContext) => ({
  cancel() {},
  dispose() {},
  checkpoint: () => codec.encode(null),
  async step(signal: AbortSignal) {
    const input = await ctx.input.accept()
    if (!input) return { outcome: 'idle' as const, phase: 'idle' as const }
    const request = await ctx.prepareRequest({
      tools: [],
      messages: [{ role: 'user', content: [...input.content] }],
    })
    await ctx.model.complete(request, signal)
    await ctx.events.assistant(
      { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
      codec.encode(null),
    )
    await ctx.checkpoints.write(codec.encode(null))
    return ctx.events.finish('completed')
  },
})
const checkpointLoop: LoopFactory = {
  id: 'test.checkpoint',
  version: '1.0.0',
  capabilities: ['model'],
  codec,
  create: driver,
  resume: driver,
}
function setup(script: SideScript = answer()) {
  const seams = fakeSeams()
  const fsOps = testFsOps()
  const loops = defaultLoops()
  loops.register('@test/checkpoint', checkpointLoop)
  const kernel = Kernel.create({
    loops,
    storage: new MemoryStorage(),
    seams,
    provider: sideProvider(script),
    contract: { contract_id: null, parser_version: '1' },
    preset: presetDefaults(),
    fsOps,
    workspaceInvocation: testWorkspaceInvocation(fsOps, seams),
    netFetch: async () => new Response(''),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    timers: noTimers,
    hookLeaseFor: () => ({ expiresAt: '2099-01-01T00:00:00Z', scope: {}, budget: { remaining: 1 } }),
    hooksFactory: (session, engine) =>
      new SessionHookPort(engine, {
        context: () => ({
          session: { key: session.key, lane: session.lane, workspaceRoot: '/w' },
          signal: session.ac.signal,
          replayed: false,
          log: session.d.logger,
        }),
        budget: () => ({ remaining: Number.MAX_SAFE_INTEGER, cap: null }),
        surface: () => [],
        surfaceDigest: () => ({ nodes: 0, tokensEstimate: 0 }),
        verifierTier: () => 0,
        contextOverflow() {},
        compactPlanIgnored() {},
      }),
  })
  return kernel
}
const meta = {
  source: 'plugin/host-owned',
  trust: 'trusted' as const,
  sideCall: true as const,
  pluginRowId: 'ext:sample/stop',
}

it('runs a granted stop hook through the real kernel after the loop records its answer and checkpoint', async () => {
  const kernel = setup()
  let result: SideCallResult | undefined
  let before: string[] = []
  kernel.hooks.on(
    'turn_stopping',
    async (_payload, ctx) => {
      const session = required(kernel.get(ctx.session.key))
      before = (await session.scan({ fromSeq: 1, limit: 500 })).map((row) => row.type)
      result = await required(ctx.sideCall).invoke(
        await required(ctx.sideCall).prepare(options()),
        ctx.signal,
      )
      return { action: 'stop' }
    },
    meta,
  )
  const session = await kernel.session('stop', {
    actor,
    resolvedProfileHash: 'test',
    cwd: '/w',
    writerRunId: 'writer',
    loop: checkpointLoop,
  })
  try {
    await session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'finish' }] })
    expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
    expect(result).toMatchObject({ status: 'ok' })
    expect(before).toContain('assistant/message')
    expect(before).toContain('x/core/loop-checkpoint')
    expect(sideCosts(await session.scan({ fromSeq: 1, limit: 500 })).map(data)).toEqual([
      expect.objectContaining({ caller: meta.pluginRowId }),
    ])
  } finally {
    await kernel.close()
  }
})

it.each(['returns', 'throws', 'times out', 'is cancelled'] as const)(
  'settles detached hook calls before dispatch %s',
  async (ending) => {
    const gate = gated()
    const kernel = setup(gate.script)
    let pending: Promise<SideCallResult> | undefined
    kernel.hooks.on(
      'turn_stopping',
      async (_payload, ctx) => {
        pending = required(ctx.sideCall).invoke(await required(ctx.sideCall).prepare(options()), ctx.signal)
        await gate.reached
        if (ending === 'returns') return { action: 'stop' }
        if (ending === 'throws') throw new Error('synthetic hook failure')
        return never()
      },
      { ...meta, hookTimeoutMs: ending === 'times out' ? 50 : 15000 },
    )
    const session = await kernel.session('lifecycle', {
      actor,
      resolvedProfileHash: 'test',
      cwd: '/w',
      writerRunId: 'writer',
    })
    try {
      await session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'finish' }] })
      const run = session.run({ until: 'turn-end', signal: new AbortController().signal })
      await gate.reached
      if (ending === 'is cancelled') session.ac.abort()
      await run
      expect(await pending).toMatchObject({ status: 'failed', reason: 'cancelled' })
      const rows = await session.scan({ fromSeq: 1, limit: 500 })
      const cost = required(sideCosts(rows)[0])
      expect(data(cost)).toMatchObject({ caller: meta.pluginRowId })
      expect(cost.seq).toBeLessThan(required(rows.find((row) => row.type === 'turn/end')).seq)
    } finally {
      gate.open()
      await kernel.close()
    }
  },
)
