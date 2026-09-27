import { afterEach, describe, expect, it } from 'vitest'
import { Kernel } from '../src/kernel.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { presetDefaults } from '../src/step/preset.js'
import { fakeProvider, textTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, noTimers, testFsOps } from './helpers/open-session.js'

const kernels: Kernel[] = []
afterEach(async () => {
  for (const k of kernels.splice(0)) await k.close()
})

describe('fork model selections', () => {
  it('pin chat slots at the child origin and never the decision slot', async () => {
    const d = presetDefaults()
    const k = Kernel.create({
      storage: new MemoryStorage(),
      seams: fakeSeams(),
      provider: fakeProvider([textTurn('hi')]),
      contract: { contract_id: null, parser_version: '1' },
      preset: {
        ...d,
        treeBudgetCredits: 100,
        generationLimit: 1,
        maxFanOut: 2,
        model: {
          ...d.model,
          route: { ...d.model.route, primary: 'gw', decision: 'jev' },
          id: { ...d.model.id, primary: 'm', decision: 'jev-1.13.0' },
        },
      },
      fsOps: testFsOps(),
      netFetch: async () => new Response(''),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      timers: noTimers,
      clock: () => 1_757_203_200_000,
    })
    kernels.push(k)
    const opts = { actor, resolvedProfileHash: 'h1', cwd: '/w' }
    const parent = await k.session('parent', { ...opts, writerRunId: 'r1' })
    const child = await k.session('child', {
      ...opts,
      writerRunId: 'r2',
      parent: { key: 'parent', boundarySeq: parent.lastSeq },
    })
    const switches = await child.d.log.scan({ type: 'x/core/model-switch', limit: 20 })
    expect(switches.map((row) => (row.data as { slot: string }).slot)).toEqual(['primary'])
    expect(switches[0]?.data).toMatchObject({ to: { route: 'gw', model: 'm' }, reason: 'fork-origin' })
  })
})
