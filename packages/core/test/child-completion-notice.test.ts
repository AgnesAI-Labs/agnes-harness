import { requireChildControl } from '@agnes/core-child-control/child/store'
import { presetDefaults } from '@agnes/core-common/step/preset'
import { buildToolContext } from '@agnes/core-effects/effects/tool-context'
import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import type { ModelRecord, Provider, SystemInput } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { deliverChildCompletion } from '../src/child/completion-notice.js'
import { Kernel } from '../src/kernel.js'
import { defaultLoops } from '../testkit/loops.js'
import { hangingProvider, slowCommits, until } from './helpers/child-traces.js'
import { fakeProvider, sentFor, textTurn } from './helpers/fake-provider.js'
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

function collectContext(parent: Parent) {
  return buildToolContext(
    {
      actor: parent.d.actor,
      lane: parent.lane,
      cwd: parent.d.cwd,
      runtime: parent.d.runtime,
      preset: parent.preset,
      children: parent.d.children,
      netFetch: parent.d.netFetch,
      sessionKey: parent.key,
      turn: 1,
      step: 1,
      depth: 0,
      generationDepth: 0,
      workspaceRoot: '/w',
      log: logger,
      fsOps: testFsOps(),
      invoke: async () => ({ content: [] }),
      listTools: () => [],
      appendPlan: async () => 1,
      requestCompaction() {},
      progress() {},
      artifactJobEvent: async () => undefined,
      lease: { remainingMs: () => 1000 },
    },
    {
      toolUseId: 'collect',
      name: 'subagent_collect',
      signal: new AbortController().signal,
      timeoutMs: 1000,
      outputMaxBytes: 32768,
    },
  ).subagent
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
      expect(await parent.acceptInput()).toBe(true)
      expect(parent.lastTurnNumber()).toBe(1)
      await k.close()
    },
  )

  it.each([
    { resident: true, wait: true, late: false },
    { resident: true, wait: true, late: true },
    { resident: false, wait: false, late: false },
    { resident: false, wait: false, late: true },
  ])(
    'collecting a finished result withdraws its wakeup across late delivery and reopen: %j',
    async ({ resident, wait, late }) => {
      const storage = new MemoryStorage()
      const first = kernel(storage)
      const parent = await first.session('parent', sessionOpts)
      const child = await parent.d.children.createWithKind!('spawn', {
        parent: parent.key,
        cwd: '/w',
        input: 'work',
        parentEffectId: 'collected',
        resident,
      })
      let release!: () => void
      let reached!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const delivering = new Promise<void>((resolve) => {
        reached = resolve
      })
      const enqueue = parent.enqueue.bind(parent)
      if (late)
        vi.spyOn(parent, 'enqueue').mockImplementation(async (...args) => {
          if (args[1].system?.type === 'child-completed') {
            reached()
            await gate
          }
          return enqueue(...args)
        })
      const run = child.run('work')
      if (late) await delivering
      else if (!wait) await run
      const result = await collectContext(parent).collect(child.key, { wait }).finally(release)
      await run
      expect(result).toMatchObject({ status: resident ? 'idle' : 'completed', text: 'child says hi' })
      expect(notices(parent)).toEqual([])
      expect(await parent.acceptInput()).toBe(false)
      expect(await storage.scan(child.key, { type: 'assistant/message', limit: 10 })).toHaveLength(1)
      await collectContext(parent).collect(child.key)
      expect(await parent.scan({ type: 'x/core/child-result-collected', limit: 10 })).toHaveLength(1)
      const record = (await requireChildControl(storage).lookupByKey(child.key))!
      const options = resident ? { continuable: true } : {}
      await deliverChildCompletion(parent, record, 'completed', options)
      expect(await parent.acceptInput()).toBe(false)
      await first.close()

      for (let reopen = 0; reopen < 2; reopen += 1) {
        const next = kernel(storage)
        const resumed = await next.session('parent', sessionOpts)
        await deliverChildCompletion(resumed, record, 'completed', options)
        expect(notices(resumed)).toEqual([])
        expect(await resumed.acceptInput()).toBe(false)
        expect(resumed.lastTurnNumber()).toBe(0)
        await next.close()
      }
    },
  )

  it.each([1, 2])(
    'collecting resident turn %i preserves the other uncollected result',
    async (collectedTurn) => {
      const k = kernel()
      const parent = await k.session('parent', sessionOpts)
      const child = await parent.d.children.createWithKind!('spawn', {
        parent: parent.key,
        cwd: '/w',
        input: 'work',
        parentEffectId: 'resident-collected',
        resident: true,
      })
      await child.run('work')
      if (collectedTurn === 1) {
        await collectContext(parent).collect(child.key)
        expect(await parent.acceptInput()).toBe(false)
      }
      await child.run('more')
      if (collectedTurn === 2) await collectContext(parent).collect(child.key)
      expect(notices(parent)).toMatchObject([
        { data: { result: collectedTurn === 1 ? 'second' : 'child says hi', continuable: true } },
      ])
      expect(await parent.acceptInput()).toBe(true)
      await k.close()
    },
  )

  it('does not suppress an uncollected failure in the next resident turn', async () => {
    let turns = 0
    const hanging = hangingProvider()
    const provider: Provider = {
      models: () => [catalogue()],
      async *infer(req, options) {
        if (turns++ === 0) {
          for (const event of textTurn('first result'))
            yield event.type === 'sent' ? sentFor(req, event) : event
        } else yield* hanging.infer(req, options)
      },
    }
    const k = kernel(new MemoryStorage(), provider)
    const parent = await k.session('parent', sessionOpts)
    const child = await parent.d.children.createWithKind!('spawn', {
      parent: parent.key,
      cwd: '/w',
      input: 'work',
      parentEffectId: 'resident-failed',
      resident: true,
    })
    await child.run('work')
    await collectContext(parent).collect(child.key)
    const running = child.run('more').catch(() => undefined)
    expect(
      await until(
        async () =>
          (
            await parent.d.log.storage.scan(child.key, {
              type: 'turn/start',
              limit: 2,
            })
          ).length === 2,
      ),
    ).toBe(true)
    await child.cancel!()
    await running
    expect(notices(parent)).toMatchObject([{ data: { status: 'cancelled' } }])
    expect(await parent.acceptInput()).toBe(true)
    await k.close()
  })

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
    expect(await child?.status()).not.toHaveProperty('idle', true)
    expect(await collectContext(parent).collect(child!.key)).toMatchObject({ status: 'running' })
    await child?.run('work')
    expect(await child?.status()).toMatchObject({ idle: true, text: 'child says hi' })
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
