import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stampFor } from '@agnes/ai/testkit'
import { seams } from '@agnes/base'
import { fakeSeamInit } from '@agnes/base/testkit'
import { contextTokens, type LedgerSeam } from '@agnes/core'
import {
  type InferenceEvent,
  type ModelRecord,
  type Provider,
  type RequestBody,
  readSessionTitle,
  SESSION_TITLE_EVENT,
} from '@agnes/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { createSqliteStorage } from '../src/adapters/storage-sqlite.js'
import type { Host, HostSession } from '../src/host.js'
import { loadSessionTitle, normalizeSessionTitle, startSessionTitle } from '../src/session-title.js'
import { createTestHost } from '../testkit/index.js'

const roots: string[] = []
const hosts: Host[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const host of hosts.splice(0)) await host.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const model = (id: string): ModelRecord => ({
  id,
  name: id,
  route: 'gw',
  api: 'openai-completions',
  baseUrl: 'https://example.invalid/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
})
const usage = (title: boolean): InferenceEvent => ({
  type: 'usage',
  tokens: { input: title ? 15 : 1000, output: title ? 4 : 50, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  credits: title ? 0.1 : 1,
  creditSource: 'gateway',
  billing: { usdMicros: title ? 100 : 1000, source: 'gateway', subscription: false },
})

async function fixture(
  options: {
    waitTitle?: Promise<void>
    title?: string
    root?: string
    failTurn?: boolean
    treeBudgetCredits?: number
    park?: boolean
    blockTitleBudget?: boolean
    ledger?: LedgerSeam
  } = {},
) {
  const root = options.root ?? realpathSync.native(mkdtempSync(join(tmpdir(), 'agnes-title-')))
  if (!options.root) roots.push(root)
  const calls: RequestBody[] = []
  const callOptions: Array<Parameters<Provider['infer']>[1]> = []
  const signals: AbortSignal[] = []
  let asked = false
  let ownedSession: HostSession | undefined
  let receipt: { requestId: string; bindingHash: string; expiresAt: string } | null = null
  const { host } = await createTestHost({
    dataDir: root,
    ...(options.park
      ? {
          packageDirs: { '@agnes/base': fileURLToPath(new URL('../../base', import.meta.url)) },
          seams: {
            approval: {
              ask: async (request: import('@agnes/core').ApprovalRequest) => {
                const expiresAt = new Date(Date.now() + 60_000).toISOString()
                receipt = { requestId: request.requestId, bindingHash: request.bindingHash, expiresAt }
                return { ticket: 'title-approval', expiresAt }
              },
              resume: async () => receipt,
            },
          },
        }
      : {}),
    ...(options.blockTitleBudget
      ? {
          seams: {
            ledger: {
              projected: async () => ({
                credits: ownedSession?.op() ? 0 : Number.POSITIVE_INFINITY,
                creditSource: 'estimated' as const,
              }),
              record: async () => undefined,
            },
          },
        }
      : {}),
    profileInputs: {
      user: {
        name: 'local-dev',
        provider: {
          package: '@agnes/ai',
          adapters: ['@agnes/ai'],
          routes: [
            {
              route: 'gw',
              api: 'openai-completions',
              baseUrl: 'https://example.invalid/v1',
              models: [model('m1'), model('m2')],
            },
          ],
        },
      },
    },
    ...(options.ledger ? { seams: { ledger: options.ledger } } : {}),
    ...(options.treeBudgetCredits === undefined ? {} : { treeBudgetCredits: options.treeBudgetCredits }),
    provider: {
      models: () => [model('m1'), model('m2')],
      async *infer(req, opts): AsyncIterable<InferenceEvent> {
        calls.push(req)
        callOptions.push(opts)
        signals.push(opts.signal)
        const title = req.sessionKey.startsWith('title:')
        yield { type: 'sent', stamp: stampFor(req) }
        if (!title && options.park && !asked) {
          asked = true
          yield {
            type: 'toolcall_end',
            via: 'native',
            call: { toolUseId: '', name: 'shell', args: { command: 'echo title-test' }, ordinal: 0 },
          }
          yield { type: 'done', reason: 'toolUse' }
          return
        }
        if (title && options.waitTitle) await options.waitTitle
        if (!title && options.failTurn) {
          yield { type: 'error', reason: 'error', code: 'AUTH', message: 'no auth', retryable: false }
          return
        }
        yield { type: 'text_delta', delta: title ? (options.title ?? '修复登录问题') : '这是完整的回答。' }
        yield usage(title)
        yield { type: 'done', reason: 'stop' }
      },
    },
  })
  hosts.push(host)
  const session = await host.createSession({ cwd: root, key: 'title-test' })
  ownedSession = session
  return { host, root, session, calls, signals, callOptions }
}
async function run(session: HostSession, text = '请修复登录问题') {
  await session.enqueue('next-turn', { actor: session.d.actor, content: [{ type: 'text', text }] })
  return session.run({ until: 'turn-end', signal: new AbortController().signal })
}
async function titleRecord(session: HostSession) {
  const events = await session.scan({ type: SESSION_TITLE_EVENT, order: 'desc', limit: 1 })
  return events[0] && readSessionTitle(events[0])
}

it('generates with the captured model, persists once, and bills the first turn without changing context', async () => {
  let finish!: () => void
  const f = await fixture({
    waitTitle: new Promise<void>((resolve) => {
      finish = resolve
    }),
  })
  expect((await run(f.session)).reason).toBe('completed')
  await vi.waitFor(() =>
    expect(f.calls.filter((call) => call.sessionKey.startsWith('title:'))).toHaveLength(1),
  )
  const baseline = contextTokens(f.session)
  expect(baseline).toBe(1050)
  await f.session.setModel({ slot: 'primary', route: 'gw', model: 'm2' })
  expect((await run(f.session, '第二个问题')).reason).toBe('completed')
  finish()
  await vi.waitFor(async () =>
    expect(await titleRecord(f.session)).toMatchObject({
      status: 'generated',
      title: '修复登录问题',
      model: 'm1',
    }),
  )
  expect(contextTokens(f.session)).toBe(baseline)
  const timeline = await f.session.projectUI(undefined, { surface: 'web' })
  expect(timeline.usage?.totals.input).toBe(2015)
  expect(timeline.turns[0]?.usage.calls.filter((call) => call.purpose === 'title')).toHaveLength(1)
  expect(timeline.turns[1]?.usage.calls.filter((call) => call.purpose === 'title')).toHaveLength(0)
  expect(f.session.surface().map((node) => node.kind)).toEqual(['user', 'assistant', 'user', 'assistant'])
  const request = f.calls.find((call) => call.sessionKey.startsWith('title:')) as RequestBody
  expect(request.tools).toEqual([])
  expect(request.model).toBe('m1')
  expect(request.sampling?.maxTokens).toBeLessThanOrEqual(1024)
  for (const [index, call] of f.calls.entries()) {
    if (call.kind === 'summary') expect(f.callOptions[index]).toHaveProperty('retry', false)
    else expect(f.callOptions[index]).not.toHaveProperty('retry')
  }
  await f.host.close()
  const reopened = await fixture({ root: f.root })
  expect(await titleRecord(reopened.session)).toMatchObject({ status: 'generated' })
  expect(contextTokens(reopened.session)).toBe(baseline)
  expect((await reopened.session.projectUI()).usage?.totals.input).toBe(2015)
  await run(reopened.session)
  expect(reopened.calls.every((call) => !call.sessionKey.startsWith('title:'))).toBe(true)
})

it('records equal-sequence title costs from separate sessions in the real ledger without replay duplicates', async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'agnes-title-ledger-')))
  roots.push(root)
  const storage = createSqliteStorage({ file: join(root, 'audit.db'), tablesDir: join(root, 'audit-tables') })
  const init = fakeSeamInit()
  init.adapters.storage = storage.tables('title-audit')
  const ledger = await seams.ledger(init)
  const recorded = vi.spyOn(ledger, 'record')
  let host: Host | undefined
  try {
    const f = await fixture({ root, ledger })
    host = f.host
    const second = await host.createSession({ cwd: root, key: 'other-title-session' })
    for (const session of [f.session, second]) {
      expect((await run(session)).reason).toBe('completed')
      await vi.waitFor(async () => expect(await titleRecord(session)).toMatchObject({ status: 'generated' }))
    }
    expect((await titleRecord(f.session))?.startSeq).toBe((await titleRecord(second))?.startSeq)
    await host.close()
    const table = init.adapters.storage.table('usage_ledger')
    const rows = () =>
      table.all<{ session_key: string; effect_id: string; credits: number }>(
        "SELECT session_key, effect_id, credits FROM usage_ledger WHERE purpose = 'title' ORDER BY session_key",
      )
    expect(rows()).toHaveLength(2)
    expect(new Set(rows().map((row) => row.effect_id)).size).toBe(2)
    expect(rows().reduce((sum, row) => sum + row.credits, 0)).toBeCloseTo(0.2)
    const titles = recorded.mock.calls.map(([row]) => row).filter((row) => row.purpose === 'title')
    expect(titles).toHaveLength(2)
    for (const row of titles) await ledger.record(row)
    expect(rows()).toHaveLength(2)
    const reopened = await fixture({ root, ledger })
    host = reopened.host
    await run(reopened.session)
    await host.close()
    expect(reopened.calls.every((call) => call.kind !== 'summary')).toBe(true)
    expect(rows()).toHaveLength(2)
  } finally {
    await host?.close()
    await storage.close()
  }
})

it.each(['valid title', '```invalid title'])(
  'recovers persisted title cost after ledger failure: %s',
  async (title) => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'agnes-title-recovery-')))
    roots.push(root)
    const storage = createSqliteStorage({
      file: join(root, 'audit.db'),
      tablesDir: join(root, 'audit-tables'),
    })
    const init = fakeSeamInit()
    init.adapters.storage = storage.tables('title-recovery')
    const real = await seams.ledger(init)
    let fail = true
    let failures = 0
    const ledger: LedgerSeam = {
      projected: real.projected,
      async record(row) {
        if (row.purpose === 'title' && fail) {
          failures++
          throw new Error('injected ledger outage')
        }
        await real.record(row)
      },
    }
    let host: Host | undefined
    try {
      const f = await fixture({ root, ledger, title })
      host = f.host
      await run(f.session)
      await vi.waitFor(() => expect(failures).toBe(1))
      await host.close()
      const rows = () =>
        init.adapters.storage
          .table('usage_ledger')
          .all<{ credits: number }>("SELECT credits FROM usage_ledger WHERE purpose = 'title'")
      expect(rows()).toHaveLength(0)
      fail = false
      for (let reopen = 0; reopen < 2; reopen++) {
        const recovered = await fixture({ root, ledger })
        host = recovered.host
        await vi.waitFor(() => expect(rows()).toEqual([{ credits: 0.1 }]))
        expect(recovered.calls).toHaveLength(0)
        expect(await titleRecord(recovered.session)).toMatchObject({
          status: title.startsWith('```') ? 'failed' : 'generated',
        })
        const local = await recovered.session.scan({ type: 'cost/ledger', toSeq: recovered.session.lastSeq })
        expect(local.filter((row) => (row.data as { purpose?: string }).purpose === 'title')).toHaveLength(1)
        await host.close()
      }
    } finally {
      await host?.close()
      await storage.close()
    }
  },
)

it('closes a hanging title adapter, records unknown usage, and ignores late output', async () => {
  let finish!: () => void
  const f = await fixture({
    waitTitle: new Promise<void>((resolve) => {
      finish = resolve
    }),
  })
  await run(f.session)
  await vi.waitFor(() => expect(f.calls).toHaveLength(2))
  await f.session.close()
  expect(f.signals[1]?.aborted).toBe(true)
  const seq = f.session.lastSeq
  finish()
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(f.session.lastSeq).toBe(seq)
  await f.host.close()
  const reopened = await fixture({ root: f.root })
  expect(await titleRecord(reopened.session)).toMatchObject({ status: 'failed', reason: 'closed' })
  const costs = await reopened.session.scan({ type: 'cost/ledger', toSeq: reopened.session.lastSeq })
  expect(costs.at(-1)?.data).toMatchObject({ purpose: 'title', interrupted: true })
  expect((costs.at(-1)?.data as { credits?: number } | undefined)?.credits).toBeUndefined()
  expect(reopened.calls).toHaveLength(0)
})

it('opens and closes promptly while title ledger recovery is hung', async () => {
  let hang = false
  let entered = false
  const ledger: LedgerSeam = {
    projected: async () => ({ credits: 0, creditSource: 'estimated' }),
    async record(row) {
      if (row.purpose === 'title' && hang) {
        entered = true
        await new Promise<void>(() => {})
      }
    },
  }
  const f = await fixture({ ledger })
  await run(f.session)
  await vi.waitFor(async () => expect(await titleRecord(f.session)).toMatchObject({ status: 'generated' }))
  await f.host.close()
  hang = true
  const reopened = await fixture({ root: f.root, ledger })
  await vi.waitFor(() => expect(entered).toBe(true))
  await reopened.host.close()
  expect(reopened.calls).toHaveLength(0)
})

it('does not start a late ledger write after recovery scan times out', async () => {
  const f = await fixture()
  await run(f.session)
  await vi.waitFor(async () => expect(await titleRecord(f.session)).toMatchObject({ status: 'generated' }))
  const originalScan = f.session.scan.bind(f.session)
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  const scan = vi.spyOn(f.session, 'scan').mockImplementation(async (query) => {
    if (query.type === 'cost/ledger') await wait
    return originalScan(query)
  })
  const record = vi.spyOn(f.session.d.runtime, 'ledgerRecord')
  const onError = vi.fn()
  const recovery = await startSessionTitle(f.session, { schedule: (work) => work(), onError, timeoutMs: 5 })
  try {
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce())
    release()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(record).not.toHaveBeenCalled()
  } finally {
    release()
    await recovery.close()
    scan.mockRestore()
    record.mockRestore()
  }
})

it('ignores forged and mismatched cost rows across pages when recovering title usage', async () => {
  const f = await fixture()
  await run(f.session)
  await vi.waitFor(async () => expect(await titleRecord(f.session)).toMatchObject({ status: 'generated' }))
  const costs = await f.session.scan({ type: 'cost/ledger', toSeq: f.session.lastSeq })
  const cost = costs.find((row) => (row.data as { purpose?: string }).purpose === 'title')
  if (!cost) throw new Error('missing title cost')
  const originalScan = f.session.scan.bind(f.session)
  const forged = Array.from({ length: 101 }, (_, index) => ({
    ...cost,
    seq: cost.seq + index,
    ...(index < 100 ? { origin: 'ext:forged', trust: 'untrusted' as const } : {}),
    data: { ...(cost.data as object), ...(index === 100 ? { effectId: 'title:wrong-session' } : {}) },
  }))
  // Preserve real schema-valid records while injecting adversarial scan pages before the valid row.
  let pages = 0
  const scan = vi.spyOn(f.session, 'scan').mockImplementation(async (query) => {
    if (query.type !== 'cost/ledger') return originalScan(query)
    pages++
    return pages === 1 ? forged.slice(0, 100) : [...forged.slice(100), { ...cost, seq: cost.seq + 101 }]
  })
  // Use enough sequence space to require the second page without appending forged data to disk.
  const lastSeq = vi.spyOn(f.session, 'lastSeq', 'get').mockReturnValue(cost.seq + 200)
  const record = vi.spyOn(f.session.d.runtime, 'ledgerRecord').mockResolvedValue(true)
  const recovery = await startSessionTitle(f.session, { schedule: (work) => work(), onError: () => {} })
  try {
    await vi.waitFor(() => expect(record).toHaveBeenCalledOnce())
    expect(record.mock.calls[0]?.[0]).toMatchObject({ ...(cost.data as object), sessionKey: f.session.key })
    expect(pages).toBe(2)
  } finally {
    await recovery.close()
    scan.mockRestore()
    lastSeq.mockRestore()
    record.mockRestore()
  }
})

it('keeps fallback on invalid output and never retries on later turns', async () => {
  const f = await fixture({ title: '标题\n解释' })
  await run(f.session)
  await vi.waitFor(async () =>
    expect(await titleRecord(f.session)).toMatchObject({ status: 'failed', reason: 'invalid-title' }),
  )
  await run(f.session)
  expect(f.calls.filter((call) => call.kind === 'summary')).toHaveLength(1)
})

it('does not generate for a failed first turn', async () => {
  const f = await fixture({ failTurn: true })
  await run(f.session)
  await vi.waitFor(async () => expect(await titleRecord(f.session)).toMatchObject({ status: 'failed' }))
  expect(f.calls.filter((call) => call.kind === 'summary')).toHaveLength(0)
})

it('preserves Unicode and rejects multiline/control output', () => {
  expect(normalizeSessionTitle(' “修复登录 🔐” ')).toBe('修复登录 🔐')
  expect(normalizeSessionTitle('😀'.repeat(81))).toBe('😀'.repeat(80))
  expect(normalizeSessionTitle('bad\u202etitle')).toBeUndefined()
  expect(normalizeSessionTitle('')).toBeUndefined()
})

it('waits through approval and generates once after the continued logical turn completes', async () => {
  const f = await fixture({ park: true })
  expect((await run(f.session)).reason).toBe('parked')
  await vi.waitFor(async () =>
    expect(await titleRecord(f.session)).toMatchObject({ status: 'pending', turn: 1 }),
  )
  expect(f.calls.filter((call) => call.kind === 'summary')).toHaveLength(0)
  await f.session.resumeApproval('title-approval', 'allowed-once', { ...f.session.d.actor, id: 'approver' })
  expect((await f.session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
    'completed',
  )
  await vi.waitFor(async () =>
    expect(await titleRecord(f.session)).toMatchObject({ status: 'generated', turn: 1 }),
  )
  const timeline = await f.session.projectUI()
  expect(timeline.turns[0]?.usage.calls.filter((call) => call.purpose === 'title')).toHaveLength(1)
  expect(f.calls.filter((call) => call.kind === 'summary')).toHaveLength(1)
})

it('times out a non-cooperative provider without changing the completed turn', async () => {
  const f = await fixture({ waitTitle: new Promise<void>(() => undefined) })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  await run(f.session)
  await vi.waitFor(() => expect(f.calls).toHaveLength(2))
  await vi.advanceTimersByTimeAsync(30_001)
  await vi.waitFor(async () => expect(await titleRecord(f.session)).toMatchObject({ status: 'failed' }))
  expect((await f.session.projectUI()).turns[0]?.status).toBe('completed')
  expect(f.signals[1]?.aborted).toBe(true)
})

it('does not overwrite a title saved while the model was answering', async () => {
  let finish!: () => void
  const f = await fixture({
    waitTitle: new Promise<void>((resolve) => {
      finish = resolve
    }),
  })
  await run(f.session)
  await vi.waitFor(() => expect(f.calls).toHaveLength(2))
  const pending = await titleRecord(f.session)
  await f.session.append([
    f.session.ev(
      SESSION_TITLE_EVENT,
      { ...pending, status: 'generated', title: '已保存的名字' },
      { ignorable: true },
    ),
  ])
  finish()
  await vi.waitFor(async () => {
    const costs = await f.session.scan({ type: 'cost/ledger', toSeq: f.session.lastSeq })
    expect(costs.some((event) => (event.data as { purpose: string }).purpose === 'title')).toBe(true)
  })
  expect(await titleRecord(f.session)).toMatchObject({ title: '已保存的名字' })
})

it('charges title usage against its own reservation in the original task budget', async () => {
  const f = await fixture({ treeBudgetCredits: 10 })
  await run(f.session)
  await vi.waitFor(async () => expect(await titleRecord(f.session)).toMatchObject({ status: 'generated' }))
  const record = await titleRecord(f.session)
  const store = f.session.d.log.storage as import('@agnes/core').ChildControlStore &
    typeof f.session.d.log.storage
  const tree = await store.projectTree(`${f.session.key}:main:${record?.startSeq}`)
  expect(tree).not.toBeNull()
  expect(tree?.settledMicro).toBe(1_100_000n)
  expect(tree?.heldMicro).toBe(0n)
})

it('does not backfill an old conversation or repeat an uncertain persisted request', async () => {
  const f = await fixture()
  await f.session.append([f.session.ev('user/message', { content: [{ type: 'text', text: 'old history' }] })])
  await f.host.close()
  const second = await fixture({ root: f.root })
  await run(second.session)
  expect(second.calls.filter((call) => call.kind === 'summary')).toHaveLength(0)
  expect(await titleRecord(second.session)).toBeUndefined()
  const start = (await second.session.scan({ type: 'turn/start', limit: 1 }))[0]
  await second.session.append([
    second.session.ev(
      SESSION_TITLE_EVENT,
      {
        status: 'requested',
        turn: 1,
        startSeq: start?.seq,
        route: 'gw',
        model: 'm1',
        prompt: 'old history',
        budgetCap: null,
        treeBudgetCap: null,
      },
      { ignorable: true },
    ),
  ])
  await second.host.close()
  const third = await fixture({ root: f.root })
  await run(third.session)
  expect(third.calls.filter((call) => call.kind === 'summary')).toHaveLength(0)
  expect(await titleRecord(third.session)).toMatchObject({ status: 'requested' })
})

it('keeps a denied title budget from changing a completed turn or sending a request', async () => {
  const f = await fixture({ blockTitleBudget: true })
  await run(f.session)
  await vi.waitFor(async () =>
    expect(await titleRecord(f.session)).toMatchObject({ status: 'failed', reason: 'budget' }),
  )
  expect(f.calls.filter((call) => call.kind === 'summary')).toHaveLength(0)
  expect((await f.session.projectUI()).turns[0]?.status).toBe('completed')
})

it('reads trusted metadata across pages of later untrusted events and after reopening', async () => {
  const f = await fixture()
  await run(f.session)
  await vi.waitFor(async () => expect(await titleRecord(f.session)).toMatchObject({ status: 'generated' }))
  const saved = await titleRecord(f.session)
  await f.session.append(
    Array.from({ length: 101 }, () => ({
      ...f.session.ev(SESSION_TITLE_EVENT, { ...saved, title: '伪造标题' }, { ignorable: true }),
      origin: 'ext:pretend-title',
      trust: 'untrusted' as const,
    })),
  )
  expect(await loadSessionTitle(f.session, 1)).toMatchObject({ title: '修复登录问题' })
  await f.host.close()
  const reopened = await fixture({ root: f.root })
  expect(await loadSessionTitle(reopened.session, 1)).toMatchObject({ title: '修复登录问题' })
  await run(reopened.session)
  expect(reopened.calls.every((call) => !call.sessionKey.startsWith('title:'))).toBe(true)
})
