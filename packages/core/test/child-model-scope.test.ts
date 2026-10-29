import { presetDefaults } from '@agnes/core-common/step/preset'
import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import type { ModelRecord } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { setChildModelScope } from '../src/child/model-scope.js'
import { Kernel } from '../src/kernel.js'
import { resolvedModelRecord } from '../src/step/model-tools.js'
import { defaultLoops } from '../testkit/loops.js'
import { fakeProvider, textTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, noTimers, testFsOps } from './helpers/open-session.js'

const record = (route: string, id: string, api = 'openai-completions'): ModelRecord => ({
  id,
  name: id,
  api,
  route,
  baseUrl: 'https://example.invalid/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 128,
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
})
const chat = record('gw', 'chat-1')
const payloadOnly = record('jev', 'jev-1', 'typesafe-systemone')
const mixed = record('mixed', 'mixed-1')
const logger = { debug() {}, info() {}, warn() {}, error() {} }

async function parentSession(preset = presetDefaults()) {
  const provider = Object.assign(fakeProvider([textTurn('child says hi')]), {
    models: () => [chat, payloadOnly, mixed],
  })
  const kernel = Kernel.create({
    loops: defaultLoops(),
    storage: new MemoryStorage(),
    seams: fakeSeams(),
    provider,
    contract: { contract_id: null, parser_version: '1' },
    preset: { ...preset, treeBudgetCredits: 100, generationLimit: 1, maxFanOut: 4 },
    fsOps: testFsOps(),
    netFetch: async () => new Response(''),
    logger,
    timers: noTimers,
    clock: () => 1_757_203_200_000,
  })
  const parent = await kernel.session('parent', {
    actor,
    resolvedProfileHash: 'h1',
    cwd: '/w',
    writerRunId: 'r1',
  })
  return { kernel, parent, provider }
}
const noPayloadOnly = (model: { route: string }) => model.route !== 'jev'
const start = (parent: Awaited<ReturnType<typeof parentSession>>['parent'], model: string) =>
  parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'task', model })

describe('models a child agent can choose', () => {
  it('lists every model of the provider when the host limits nothing', async () => {
    const { kernel, parent } = await parentSession()
    try {
      expect((await parent.d.children.models?.())?.map((model) => model.selector)).toEqual([
        'gw/chat-1',
        'jev/jev-1',
        'mixed/mixed-1',
      ])
    } finally {
      await kernel.close()
    }
  })

  it('leaves out the models the host excludes, and keeps a mixed adapter', async () => {
    const { kernel, parent, provider } = await parentSession()
    try {
      setChildModelScope(provider, noPayloadOnly)
      expect((await parent.d.children.models?.())?.map((model) => model.selector)).toEqual([
        'gw/chat-1',
        'mixed/mixed-1',
      ])
    } finally {
      await kernel.close()
    }
  })

  it('refuses to start a child on an excluded model, named by route, by id or by slot', async () => {
    const preset = presetDefaults()
    preset.model.route.fast = 'jev'
    const { kernel, parent, provider } = await parentSession(preset)
    try {
      setChildModelScope(provider, noPayloadOnly)
      for (const selector of ['jev/jev-1', 'jev-1', 'fast'])
        await expect(start(parent, selector)).rejects.toMatchObject({
          code: 'E_MODEL_UNKNOWN',
          detail: { model: selector },
        })
      // The same selectors are accepted for models the host did not exclude.
      for (const selector of ['gw/chat-1', 'mixed/mixed-1', 'mixed-1'])
        expect((await start(parent, selector)).key).toBeDefined()
    } finally {
      await kernel.close()
    }
  })

  it('does not change what the provider publishes, so a side call can still target the model', async () => {
    const { kernel, provider } = await parentSession()
    try {
      setChildModelScope(provider, noPayloadOnly)
      expect(provider.models().map((model) => `${model.route}/${model.id}`)).toContain('jev/jev-1')
      expect(resolvedModelRecord(provider, { route: 'jev', model: 'jev-1' })).toMatchObject({ id: 'jev-1' })
    } finally {
      await kernel.close()
    }
  })
})
