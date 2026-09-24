import type { ModelRecord } from '@agnes/protocol'
import { expect, it, vi } from 'vitest'
import { Kernel } from '../src/kernel.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import type { StorageAdapter } from '../src/log/storage.js'
import { presetDefaults } from '../src/step/preset.js'
import type { SessionImpl } from '../src/step/session.js'
import type { IdMinter, Seq } from '../src/types.js'
import { type FakeProvider, fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, noTimers, readTool, testFsOps } from './helpers/open-session.js'

const CLOCK = 1_757_203_200_000
const signal = () => new AbortController().signal
const sessionOpts = { actor, resolvedProfileHash: 'h1', cwd: '/w' }
const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}
const model = (): ModelRecord => ({
  id: 'm1',
  name: 'm1',
  api: 'openai-completions',
  route: 'default',
  baseUrl: 'https://example.invalid/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 128,
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
})
const fixedIds = (): IdMinter => {
  let n = 0
  const next = () => String(++n).padStart(32, '0')
  return {
    ulid: () => next().slice(-26),
    effectId: () => `e-${next()}`,
    toolUseId: (o) => `t${o}-${next()}`,
    requestId: () => `r-${next()}`,
    nonce: () => next(),
  }
}

type CreateOpts = Parameters<NonNullable<SessionImpl['d']['children']['createWithKind']>>[1]
/** The kernel's own child factory, the entry the subagent tools use. */
function createChild(from: SessionImpl, kind: 'fork' | 'spawn', opts: CreateOpts) {
  const create = from.d.children.createWithKind
  if (!create) throw new Error('this child factory cannot create by kind')
  return create.call(from.d.children, kind, opts)
}

function kernel(storage: StorageAdapter, provider: FakeProvider) {
  Object.assign(provider, { models: () => [model()] })
  const k = Kernel.create({
    storage,
    seams: fakeSeams(),
    provider,
    contract: { contract_id: null, parser_version: '1' },
    preset: { ...presetDefaults(), treeBudgetCredits: 1_000, generationLimit: 3, maxFanOut: 8 },
    fsOps: testFsOps(),
    netFetch: async () => new Response(''),
    logger,
    timers: noTimers,
    clock: () => CLOCK,
    ids: fixedIds(),
  })
  k.tools.add(readTool(), { source: 'agnes/base', trust: 'builtin' })
  return k
}

const counter = vi.hoisted(() => ({ on: false, calls: 0 }))
vi.mock('../src/reduce/reducer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/reduce/reducer.js')>()
  return {
    ...actual,
    reduce: (...args: Parameters<typeof actual.reduce>) => {
      if (counter.on) counter.calls++
      return actual.reduce(...args)
    },
  }
})

const reads = (n: number) => Array.from({ length: n }, (_, i) => toolTurn('read', { path: `${i}` }))

// Every reduce during creation - the tracker's, the UI cell's and the relation check's - is bounded
// by the parent rows past the fork point and the child's own rows, however long the parent is.
it.each(['fork', 'spawn'] as const)(
  'creating a %s child folds only what the parent did not already have',
  async (kind) => {
    const storage = new MemoryStorage({ clock: () => CLOCK })
    const k = kernel(storage, fakeProvider([...reads(30), textTurn('done'), textTurn('child')]))
    const parent = await k.session('parent', { ...sessionOpts, writerRunId: 'r1' })
    await parent.enqueue('next-turn', { content: [{ type: 'text', text: 'read' }], actor })
    expect((await parent.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')
    await parent.enqueue('next-turn', { content: [{ type: 'text', text: 'delegate' }], actor })
    await parent.acceptInput()
    const c = (parent.d.log.latest('op.state', 'main') as { meta: { triggerSeq: Seq } }).meta.triggerSeq
    counter.calls = 0
    counter.on = true
    const handle = await createChild(parent, kind, { parent: parent.key, cwd: '/w', input: 'x' })
    counter.on = false
    const child = k.get(handle.key)
    const b = child?.d.log.parent?.boundarySeq as Seq
    const own = (child?.lastSeq as Seq) - b
    expect(b).toBeGreaterThan(500)
    expect(counter.calls).toBeGreaterThan(0)
    expect(counter.calls).toBeLessThanOrEqual(b - c + 3 * own)
    await k.close()
  },
)
