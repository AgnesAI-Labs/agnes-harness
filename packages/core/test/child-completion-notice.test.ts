import { requireChildControl } from '@agnes/core-child-control/child/store'
import { presetDefaults } from '@agnes/core-common/step/preset'
import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import type { ModelRecord, Provider, SystemInput } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { Kernel } from '../src/kernel.js'
import { defaultLoops } from '../testkit/loops.js'
import { hangingProvider, slowCommits, until } from './helpers/child-traces.js'
import { fakeProvider, textTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, noTimers, testFsOps } from './helpers/open-session.js'

const catalogue = (): ModelRecord => ({
  id: 'm1',
  name: 'm1',
  api: 'openai-completions',
  route: 'default',
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

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}
const sessionOpts = { actor, resolvedProfileHash: 'h1', cwd: '/w', writerRunId: 'r1' }

function kernel(storage = new MemoryStorage(), provider?: Provider) {
  return Kernel.create({
    loops: defaultLoops(),
    storage,
    seams: fakeSeams(),
    provider:
      provider ??
      Object.assign(fakeProvider([textTurn('child says hi'), textTurn('second')]), {
        models: () => [catalogue()],
      }),
    contract: { contract_id: null, parser_version: '1' },
    preset: { ...presetDefaults(), treeBudgetCredits: 100, generationLimit: 1, maxFanOut: 4 },
    fsOps: testFsOps(),
    netFetch: async () => new Response(''),
    logger,
    timers: noTimers,
    clock: () => 1_757_203_200_000,
  })
}

type Parent = Awaited<ReturnType<ReturnType<typeof kernel>['session']>>

function notices(parent: Parent): SystemInput[] {
  const inbox = parent.latest('inbox') as { items: Array<{ system?: SystemInput }> } | undefined
  return (inbox?.items ?? []).flatMap((item) =>
    item.system?.type === 'child-completed' ? [item.system] : [],
  )
}

describe('child completion notice', () => {
  it.each([undefined, { ref: '@fixture/roles#reader', title: { en: 'Reader', 'zh-CN': '读者' } }])(
    'delivers one durable structured notice with optional backend role attribution: %j',
    async (role) => {
      const k = kernel()
      const parent = await k.session('parent', sessionOpts)
      const child = await parent.d.children.createWithKind?.('spawn', {
        parent: parent.key,
        cwd: '/w',
        input: 'summarise the repo\nsecond line',
        parentEffectId: 'call-1',
      })
      if (role && child) {
        const session = k.get(child.key)!
        await session.d.log.append([
          session.ev(
            'x/core/role-delegation',
            { role },
            { register: 'x/core/role-delegation', ignorable: true },
          ),
        ])
      }
      await child?.run('summarise the repo\nsecond line')
      const [notice, ...rest] = notices(parent)
      expect(rest).toEqual([])
      expect(notice).toMatchObject({
        source: 'agnes/child',
        type: 'child-completed',
        data: { childKey: child?.key, status: 'completed', result: 'child says hi' },
        presentation: {
          kind: 'child-completed',
          status: 'completed',
          label: role ? '读者' : 'summarise the repo',
        },
      })
      expect(notice?.summary).toContain('child says hi')
      if (role) {
        expect(notice?.data).toMatchObject({ role })
        expect(notice?.summary).toContain('由 读者 处理')
      }
      await k.close()
    },
  )

  it('does not notify for an awaited fork', async () => {
    const k = kernel()
    const parent = await k.session('parent', sessionOpts)
    const child = await parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'question' })
    await child.run('question')
    expect(notices(parent)).toEqual([])
    await k.close()
  })

  it('reports an idle continuable child as completed and still messageable', async () => {
    const k = kernel()
    const parent = await k.session('parent', sessionOpts)
    const child = await parent.d.children.createWithKind?.('spawn', {
      parent: parent.key,
      cwd: '/w',
      input: 'work',
      parentEffectId: 'call-2',
      resident: true,
    })
    await child?.run('work')
    expect(notices(parent)).toMatchObject([{ data: { status: 'completed', continuable: true } }])
    await k.close()
  })

  it.each(['parent', `agent:${'a'.repeat(64)}`])(
    'recovers a missed terminal notice exactly once across reopen: %s',
    async (parentKey) => {
      const storage = new MemoryStorage()
      const first = kernel(storage)
      const parent = await first.session(parentKey, sessionOpts)
      const child = await parent.d.children.createWithKind?.('spawn', {
        parent: parent.key,
        cwd: '/w',
        input: 'work',
        parentEffectId: 'call-3',
      })
      const session = first.get(child?.key ?? '')!
      await session.d.log.append([
        session.ev(
          'x/core/role-delegation',
          { role: { ref: '@fixture/roles#reader', title: { en: 'Reader', 'zh-CN': '读者' } } },
          { register: 'x/core/role-delegation', ignorable: true },
        ),
      ])
      const store = requireChildControl(storage)
      const live = await store.lookupByKey(child?.key ?? '')
      await store.casState(live?.childKey ?? '', live?.stateRevision ?? 0, 'cancelled')
      expect(notices(parent)).toEqual([])
      await first.close()

      for (let reopen = 0; reopen < 2; reopen += 1) {
        const next = kernel(storage)
        const resumed = await next.session(parentKey, sessionOpts)
        expect(notices(resumed)).toMatchObject([
          {
            data: { childKey: child?.key, status: 'cancelled', role: { ref: '@fixture/roles#reader' } },
            presentation: { status: 'cancelled', label: '读者' },
          },
        ])
        await next.close()
      }
    },
  )

  it('keeps one terminal notice when a cancelled child writes its last turn after the first delivery', async () => {
    const storage = new MemoryStorage()
    const first = kernel(storage, hangingProvider())
    const parent = await first.session('parent', sessionOpts)
    const child = await parent.d.children.createWithKind?.('spawn', {
      parent: parent.key,
      cwd: '/w',
      input: 'work',
      parentEffectId: 'call-4',
    })
    const childKey = child?.key ?? ''
    const running = child?.run('work').catch(() => undefined)
    expect(
      await until(
        async () => (await storage.scan(childKey, { type: 'assistant/output', limit: 1 })).length > 0,
      ),
    ).toBe(true)
    const slow = slowCommits(storage, () => childKey)
    slow.value = true
    await child?.cancel?.()
    expect(notices(parent)).toHaveLength(1)
    await running
    expect((await storage.scan(childKey, { type: 'turn/end', limit: 1 })).length).toBeGreaterThan(0)
    await first.close()

    for (let reopen = 0; reopen < 2; reopen += 1) {
      const next = kernel(storage)
      const resumed = await next.session('parent', sessionOpts)
      expect(notices(resumed)).toMatchObject([{ data: { childKey, status: 'cancelled' } }])
      await next.close()
    }
  })
})
