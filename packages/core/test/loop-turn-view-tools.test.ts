import { presetDefaults } from '@agnes/core-common/step/preset'
import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import { type LoopFactory, type LoopTurnView, loopCheckpointCodec } from '@agnes/extension-api'
import type { RequestBody } from '@agnes/protocol'
import { Type } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import { Kernel } from '../src/kernel.js'
import { defaultLoops } from '../testkit/loops.js'
import { fakeProvider, textTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import {
  actor,
  noTimers,
  readTool,
  shellTool,
  testFsOps,
  testWorkspaceInvocation,
} from './helpers/open-session.js'

const codec = loopCheckpointCodec(1, (state) => state)
const baseMeta = {
  isReadOnly: true,
  isDestructive: false,
  isConcurrencySafe: true,
  isOpenWorld: false,
  replay: 'safe' as const,
  costHint: undefined,
  deferLoading: undefined,
  requiresApproval: undefined,
}
const tool = (name: string, meta: object) =>
  ({
    name,
    description: name,
    parameters: Type.Object({}),
    meta: { ...baseMeta, ...meta },
    execute: async () => ({ content: [] }),
  }) as never

async function viewAndRequest(
  input: ('text' | 'image')[],
  disclosure: 'standard' | 'hybrid' | 'code' = 'standard',
): Promise<{ view: LoopTurnView; request: RequestBody }> {
  let view: LoopTurnView | null = null
  const loop: LoopFactory = {
    id: 'test.view-tools',
    version: '1.0.0',
    capabilities: ['model', 'tools'],
    codec,
    create: (ctx) => ({
      checkpoint: () => codec.encode('ready'),
      cancel() {},
      dispose() {},
      async step(signal) {
        await ctx.input.claim('next-turn')
        view = await ctx.turn.view()
        await ctx.model.complete(await ctx.prepareRequest({}), signal)
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
  loops.register('@test/view-tools', loop)
  const provider = fakeProvider([textTurn('ok')])
  provider.models = () =>
    [
      {
        id: 'm',
        route: 'default',
        name: 'fake',
        api: 'openai-completions',
        baseUrl: 'https://test.invalid',
        input,
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
    preset: { ...presetDefaults(), disclosure },
    fsOps: testFsOps(),
    netFetch: async () => new Response(''),
    timers: noTimers,
    imageInputTokenFallback: async ({ imageCount }) => ({ tokens: 100, imageCount }),
  })
  k.tools.add(readTool(), { source: 'test', trust: 'builtin' })
  k.tools.add(shellTool(), { source: 'test', trust: 'builtin' })
  k.tools.add(tool('docs_search', { isOpenWorld: true }), { source: 'test', trust: 'builtin' })
  k.tools.add(tool('hidden_target', { modelVisible: false }), { source: 'test', trust: 'builtin' })
  k.tools.add(tool('screen', { isReadOnly: false, requiresImageInput: true }), {
    source: 'test',
    trust: 'builtin',
  })
  k.tools.add(tool('later', { deferLoading: true }), { source: 'test', trust: 'builtin' })
  k.tools.add(tool('run_code', { isReadOnly: false }), { source: 'test', trust: 'builtin' })
  // A capitalised name sorts differently by code unit than by locale, so it pins the order requests use.
  k.tools.add(tool('Draft', {}), { source: 'test', trust: 'builtin' })
  try {
    const session = await k.session('view-tools', {
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
  if (!view || !provider.requests[0]) throw new Error('the loop saw no view or sent no request')
  return { view, request: provider.requests[0] }
}

describe('turn view tool facts', () => {
  it.each([
    [['text'], false],
    [['text', 'image'], true],
  ] as const)(
    'lists the names a request without tools sends, for a model taking %j',
    async (input, images) => {
      const { view, request } = await viewAndRequest([...input])
      expect(view.disclosedTools).toEqual(request.tools.map((t) => t.name))
      expect(view.disclosedTools).not.toContain('hidden_target')
      expect(view.disclosedTools).not.toContain('later')
      expect(view.disclosedTools?.includes('screen')).toBe(images)
    },
  )
  it.each([
    ['hybrid', ['Draft', 'docs_search', 'read', 'run_code', 'shell']],
    ['code', ['run_code']],
    ['standard', ['Draft', 'docs_search', 'read', 'shell']],
  ] as const)('lists the names and order a %s disclosure request sends', async (disclosure, names) => {
    const { view, request } = await viewAndRequest(['text'], disclosure)
    expect(request.tools.map((t) => t.name)).toEqual(names)
    expect(view.disclosedTools).toEqual(names)
  })
  it.each([[['text']], [['text', 'image']]] as const)(
    'gives every catalog tool its static facts (%j)',
    async (input) => {
      const { view } = await viewAndRequest([...input])
      expect(view.toolMeta?.read).toEqual({
        isReadOnly: true,
        isDestructive: false,
        isOpenWorld: false,
        offered: true,
      })
      expect(view.toolMeta?.shell).toMatchObject({ isReadOnly: false, isDestructive: true, offered: true })
      expect(view.toolMeta?.docs_search).toMatchObject({ isReadOnly: true, isOpenWorld: true })
      expect(view.toolMeta?.hidden_target?.offered).toBe(false)
      expect(view.toolMeta?.later?.offered).toBe(true)
      expect(view.toolMeta?.screen?.offered).toBe(input.length === 2)
      expect(Object.keys(view.toolMeta ?? {}).sort()).toEqual(view.tools.map((t) => t.name).sort())
    },
  )
  it('leaves the elements of view.tools as they were', async () => {
    const { view } = await viewAndRequest(['text'])
    for (const t of view.tools) expect(Object.keys(t).sort()).toEqual(['description', 'name', 'parameters'])
    expect(Object.isFrozen(view.toolMeta)).toBe(true)
  })
})
