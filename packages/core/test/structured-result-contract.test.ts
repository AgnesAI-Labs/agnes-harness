import { presetDefaults } from '@agnes/core-common/step/preset'
import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import { type LoopContext, type LoopFactory, loopCheckpointCodec } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import { Kernel } from '../src/kernel.js'
import { ToolRegistry } from '../src/registry/tools.js'
import { defaultLoops } from '../testkit/loops.js'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import {
  actor,
  noTimers,
  openSession,
  readTool,
  testFsOps,
  testWorkspaceInvocation,
} from './helpers/open-session.js'

const PATHS = {
  schema: 'agh.path-references/1',
  references: [{ kind: 'file', path: 'a.ts' }],
  total: 1,
  truncated: false,
}
/** Random ids differ between runs; everything else in a request must not. */
const scrub = (value: unknown) =>
  JSON.parse(JSON.stringify(value).replace(/\b([ert])(\d*)-[0-9a-f]{32}\b/g, '$1$2-id'))

async function secondRequest(structured: unknown) {
  const registry = new ToolRegistry()
  registry.add(
    readTool(async () => ({
      content: [{ type: 'text', text: 'a.ts' }],
      ...(structured === undefined ? {} : { structured }),
    })),
    { source: 's', trust: 'builtin' },
  )
  const provider = fakeProvider([toolTurn('read', {}), textTurn('done')])
  const { session } = await openSession({ provider, registry })
  await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
  expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
    'completed',
  )
  const request = provider.requests[1]
  if (!request) throw new Error('the default loop sent no second request')
  return request
}

const codec = loopCheckpointCodec(1, (state) => state)
type Probe = (ctx: LoopContext, signal: AbortSignal) => Promise<void>

/** Runs one turn of a custom loop that hands its context to `probe`, on a real kernel. */
async function runLoopOnKernel(probe: Probe, tool: never) {
  const loop: LoopFactory = {
    id: 'test.structured-probe',
    version: '1.0.0',
    capabilities: ['model', 'tools'],
    codec,
    create: (ctx) => ({
      checkpoint: () => codec.encode('ready'),
      cancel() {},
      dispose() {},
      async step(signal) {
        await ctx.input.claim('next-turn')
        await probe(ctx, signal)
        await ctx.events.assistant(
          { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
          codec.encode('done'),
        )
        return ctx.events.finish('completed')
      },
    }),
    resume: () => {
      throw new Error('not resumed in this test')
    },
  }
  const loops = defaultLoops()
  loops.register('@test/structured-probe', loop)
  const provider = fakeProvider([textTurn('unused')])
  provider.models = () =>
    [
      {
        id: 'm',
        route: 'default',
        name: 'fake',
        api: 'openai-completions',
        baseUrl: 'https://test.invalid',
        input: ['text'],
        reasoning: false,
        contextWindow: 10000,
        maxTokens: 1000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        toolCallFormats: ['native'],
        thinkingReplay: 'native',
        contract_id: null,
      },
    ] as never
  const k = Kernel.create({
    storage: new MemoryStorage(),
    loops,
    seams: fakeSeams(),
    provider,
    contract: { contract_id: null, parser_version: '1' },
    preset: presetDefaults(),
    fsOps: testFsOps(),
    netFetch: async () => new Response(''),
    timers: noTimers,
    imageInputTokenFallback: async ({ imageCount }) => ({ tokens: 100, imageCount }),
  })
  k.tools.add(tool, { source: 'test', trust: 'builtin' })
  try {
    const session = await k.session('structured-probe', {
      actor,
      resolvedProfileHash: null,
      cwd: '/w',
      writerRunId: 'test-writer',
      workspaceInvocation: testWorkspaceInvocation(),
      loop,
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
  } finally {
    await k.close()
  }
}

describe('structured tool results', () => {
  it('leave the default loop request unchanged', async () => {
    const plain = await secondRequest(undefined)
    const withPaths = await secondRequest(PATHS)
    expect(withPaths.system).toBe(plain.system)
    expect(withPaths.tools).toEqual(plain.tools)
    expect(scrub(withPaths.messages)).toEqual(scrub(plain.messages))
    expect(JSON.stringify(withPaths.messages)).not.toContain('agh.path-references')
  })

  it('keeps a large structured result out of the model text', async () => {
    const big = {
      ...PATHS,
      references: Array.from({ length: 100 }, (_, i) => ({ kind: 'file', path: `${'d'.repeat(1000)}/${i}` })),
    }
    const withBig = await secondRequest(big)
    expect(JSON.stringify(withBig.messages)).not.toContain('[output truncated')
  })

  it('reach a loop through tools.execute and through effects.status after the call', async () => {
    let seen: { result: unknown; status: unknown } | undefined
    const probe: Probe = async (ctx, signal) => {
      const result = await ctx.tools.execute({ invocationId: 'call-1', name: 'read', args: {} }, signal, {
        announce: true,
      })
      seen = { result, status: await ctx.effects.status('call-1') }
    }
    await runLoopOnKernel(
      probe,
      readTool(async () => ({ content: [{ type: 'text', text: 'a.ts' }], structured: PATHS })),
    )
    expect(seen?.result).toMatchObject({ structured: PATHS })
    expect(seen?.status).toMatchObject({ status: 'responded', result: { structured: PATHS } })
  })
})
