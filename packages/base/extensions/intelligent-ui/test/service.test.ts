import { describe, expect, it } from 'vitest'
import { Type } from '@sinclair/typebox'
import { jcs, type Actor, type EventEnvelope, type UiActionParams, type UiSurface } from '@agnes/protocol'
import type {
  DeferredInvocationReceipt,
  DeferredToolInvocation,
  DeferredToolInvocationQueue,
  IntelligentUiService,
} from '@agnes/extension-api'
import { validIntelligentSurface } from '@agnes/protocol/intelligent-ui'
import { createIntelligentUiService } from '../src/service.js'
import { uiProjection } from '../src/state.js'

const actor: Actor = { id: 'operator', org: 'synthetic', role: 'owner', deptPath: [], attrs: {} }
const signal = new AbortController().signal
const parameters = Type.Object(
  {
    amount: Type.Number(),
    reason: Type.String({ minLength: 1 }),
    rows: Type.Array(Type.Object({ id: Type.String(), amount: Type.Number() })),
  },
  { additionalProperties: false },
)
const surface = (): UiSurface => ({
  id: 'reconcile',
  revision: 1,
  title: 'Differences',
  placement: { inline: true, workbench: true },
  data: {
    rows: [{ id: 'a', amount: 12 }],
    chart: [{ label: 'a', amount: 12 }],
    form: { amount: 12, reason: 'reviewed' },
    status: 'Review adjustments',
  },
  components: [
    {
      id: 'differences',
      kind: 'table',
      dataKey: 'rows',
      rowKey: 'id',
      columns: [
        { key: 'id', label: 'Id' },
        { key: 'amount', label: 'Amount' },
      ],
      selection: 'multiple',
      rowActionIds: ['confirm'],
    },
    {
      id: 'amounts',
      kind: 'chart',
      chartType: 'bar',
      dataKey: 'chart',
      categoryKey: 'label',
      series: [{ key: 'amount', label: 'Amount' }],
    },
    {
      id: 'adjustment',
      kind: 'form',
      dataKey: 'form',
      schema: {
        type: 'object',
        required: ['amount', 'reason'],
        properties: { amount: { type: 'number' }, reason: { type: 'string', minLength: 1 } },
        additionalProperties: false,
      },
      actionIds: ['confirm'],
    },
    { id: 'controls', kind: 'button-group', actionIds: ['confirm'] },
    { id: 'summary', kind: 'status', dataKey: 'status' },
  ],
  actions: [
    {
      id: 'confirm',
      label: 'Confirm',
      tool: 'adjust',
      confirm: 'Confirm adjustment?',
      argsTemplate: {
        amount: { from: 'input', key: 'adjustment', pointer: '/amount' },
        reason: { from: 'input', key: 'adjustment', pointer: '/reason' },
        rows: { from: 'selection', key: 'differences' },
      },
      paramsSchema: {
        type: 'object',
        required: ['amount', 'reason', 'rows'],
        properties: { amount: { type: 'number' }, reason: { type: 'string' }, rows: { type: 'array' } },
        additionalProperties: false,
      },
    },
  ],
})
const request = (commandId = 'one'): UiActionParams => ({
  sessionId: 'session',
  surfaceId: 'reconcile',
  revision: 1,
  actionId: 'confirm',
  commandId,
  input: { adjustment: { amount: 12, reason: 'reviewed' } },
  selection: { differences: ['a'] },
  confirmed: true,
})
function fixture() {
  const rows: EventEnvelope[] = [],
    calls = new Map<string, DeferredInvocationReceipt>(),
    deliveries = new Map<string, number>()
  let service: IntelligentUiService,
    available = true,
    now = 100000,
    lostWake = false,
    failDelivery = false,
    failAdmission = false
  const row = (name: string, data: unknown, origin = 'ext:agnes/intelligent-ui') => {
    const seq = rows.length + 1
    rows.push({
      seq,
      id: `row-${seq}`,
      ts: new Date(now).toISOString(),
      type: `x/agnes/intelligent-ui/${name}`,
      data: JSON.parse(jcs(data)),
      actor,
      origin,
      trust: 'untrusted',
      lane: 'main',
      ignorable: true,
    })
    return seq
  }
  const queue: DeferredToolInvocationQueue = {
    sessionKey: 'session',
    lane: 'main',
    async enqueue(invocation, signal) {
      if (failAdmission) throw new Error('admission unavailable')
      const old = calls.get(invocation.id)
      if (old) {
        if (jcs(old.invocation) !== jcs(invocation)) throw new Error('conflict')
        return old
      }
      await service.validate(invocation, signal)
      const receipt: DeferredInvocationReceipt = {
        invocation,
        state: 'queued',
        seq: row('queue', { invocation }),
      }
      calls.set(invocation.id, receipt)
      if (lostWake) throw new Error('wake lost after durable admission')
      return receipt
    },
    async next() {
      return [...calls.values()].find((item) => !['succeeded', 'failed'].includes(item.state)) ?? null
    },
    async read(id) {
      return calls.get(id) ?? null
    },
    async transition(id, _seq, state, outcome = {}) {
      const old = calls.get(id)!
      const receipt = { ...old, ...outcome, state, seq: row('queue', { id, state }) }
      calls.set(id, receipt)
      return receipt
    },
    async notify(signal) {
      for (const receipt of calls.values()) await service.changed(receipt, signal)
    },
  }
  const restart = () =>
    (service = createIntelligentUiService({
      session: { key: 'session', lane: 'main', workspaceRoot: '/synthetic' },
      owner: 'agnes/intelligent-ui',
      get lastSeq() {
        return rows.length
      },
      taskId: 'task',
      supportsDeferredInvocations: true,
      queue,
      scan: async () => rows,
      append: async (name, data) => row(name, data),
      tools: () => (available ? [{ name: 'adjust', parameters }] : []),
      now: () => now,
      async deliver(key, _text, _actor, signal) {
        signal.throwIfAborted()
        if (failDelivery) throw new Error('delivery interrupted')
        if (!deliveries.has(key)) deliveries.set(key, row('inbox', { key }))
        return deliveries.get(key)!
      },
    }))
  restart()
  return {
    rows,
    calls,
    deliveries,
    queue,
    restart,
    service: () => service,
    row,
    tool: (value: boolean) => (available = value),
    clock: (value: number) => (now = value),
    wakeFail: (value: boolean) => (lostWake = value),
    deliveryFail: (value: boolean) => (failDelivery = value),
    admissionFail: (value: boolean) => (failAdmission = value),
    async outcome(state: DeferredInvocationReceipt['state'], error?: DeferredInvocationReceipt['error']) {
      const old = [...calls.values()].at(-1)!
      const seq = row('queue', { state })
      const receipt: DeferredInvocationReceipt = {
        ...old,
        state,
        seq,
        ...(state === 'pending-approval' ? { approvalId: 'original-ticket' } : {}),
        ...(state === 'succeeded'
          ? {
              resultSeq: row('tool-result', {}),
              result: { content: [{ type: 'text', text: 'Adjustment recorded' }] },
            }
          : {}),
        ...(error ? { error } : {}),
      }
      calls.set(old.invocation.id, receipt)
      await service.changed(receipt, signal)
    },
  }
}
async function opened() {
  const f = fixture()
  await f.service().render({ surface: surface() }, signal)
  return f
}

describe('preset surface contract and ledger lifecycle', () => {
  it('opens, replaces revision n+1, closes and retains a tombstone across restart', async () => {
    const f = await opened(),
      first = (await f.service().read({ sessionId: 'session' }, signal)).surfaces[0]!
    expect(first).toMatchObject({
      status: 'open',
      owner: 'agnes/intelligent-ui',
      lane: 'main',
      taskId: 'task',
    })
    const updated = surface()
    updated.revision = 2
    updated.data.status = 'Finished'
    await f.service().update({ surfaceId: 'reconcile', expectedRevision: 1, surface: updated }, signal)
    await f.service().close({ surfaceId: 'reconcile', expectedRevision: 2 }, signal)
    const before = f.rows.length
    await f.service().close({ surfaceId: 'reconcile', expectedRevision: 2 }, signal)
    expect(f.rows).toHaveLength(before)
    f.restart()
    expect((await f.service().read({ sessionId: 'session', surfaceId: 'reconcile' }, signal)).surfaces[0]).toMatchObject({
      status: 'closed',
      surface: { revision: 2 },
    })
    await expect(f.service().render({ surface: surface() }, signal)).rejects.toMatchObject({
      data: { code: 'UI_STALE' },
    })
  })
  it('records received, executing, original approval, success and one SC1 delivery', async () => {
    const f = await opened()
    expect(await f.service().action(request(), actor, signal)).toMatchObject({ status: 'received' })
    expect([...f.calls.values()][0]!.invocation.args).toEqual({
      amount: 12,
      reason: 'reviewed',
      rows: [{ id: 'a', amount: 12 }],
    })
    await f.outcome('executing')
    await f.outcome('pending-approval')
    f.restart()
    expect((await f.service().read({ sessionId: 'session' }, signal)).actions[0]).toMatchObject({
      status: 'pending-approval',
      approvalId: 'original-ticket',
    })
    await f.outcome('executing')
    await f.outcome('succeeded')
    const duplicate = await f.service().action(request(), actor, signal)
    expect(duplicate).toMatchObject({ status: 'succeeded', duplicate: true, resultSeq: expect.any(Number) })
    expect(f.deliveries.size).toBe(1)
    expect(f.calls.size).toBe(1)
    expect(f.rows.filter((row) => row.type.endsWith('action.executing'))).toHaveLength(2)
  })
  it.each(['invalid', 'stale', 'closed', 'unauthorized'] as const)(
    'persists typed refusal %s and delivers it',
    async (reason) => {
      const f = await opened(),
        req = request()
      if (reason === 'invalid') req.selection = { differences: ['forged-row'] }
      if (reason === 'stale') req.revision = 2
      if (reason === 'closed')
        await f.service().close({ surfaceId: 'reconcile', expectedRevision: 1 }, signal)
      if (reason === 'unauthorized') {
        const open = f.rows.find((row) => row.type.endsWith('surface.opened'))!
        ;(open.data as any).record.owner = 'another-plugin'
      }
      const receipt = await f.service().action(req, actor, signal)
      expect(receipt).toMatchObject({ status: 'rejected', refusal: { reason } })
      expect(f.calls.size).toBe(0)
      expect(f.deliveries.size).toBe(1)
      expect(f.rows.some((row) => row.type.endsWith('action.received'))).toBe(true)
    },
  )
  it('dedupes before stale/quota, refuses a changed command binding and cross-session access', async () => {
    const f = await opened()
    await f.service().action(request(), actor, signal)
    await f.outcome('executing')
    await f.outcome('succeeded')
    const next = surface()
    next.revision = 2
    await f.service().update({ surfaceId: 'reconcile', expectedRevision: 1, surface: next }, signal)
    expect(await f.service().action(request(), actor, signal)).toMatchObject({
      duplicate: true,
      status: 'succeeded',
    })
    await expect(f.service().action({ ...request(), revision: 2 }, actor, signal)).rejects.toMatchObject({
      data: { code: 'UI_COMMAND_CONFLICT' },
    })
    await expect(
      f.service().action({ ...request(), sessionId: 'other' }, actor, signal),
    ).rejects.toMatchObject({ code: expect.any(Number) })
    expect(f.calls.size).toBe(1)
  })
  it.each(['HOOK_DENIED', 'AUTHZ_DENIED', 'POLICY_DENIED', 'APPROVAL_REJECTED', 'SANDBOX_UNAVAILABLE'])(
    'reuses backend denial %s as unauthorized',
    async (code) => {
      const f = await opened()
      await f.service().action(request(), actor, signal)
      await f.outcome('failed', { code, message: 'Denied', outcomeUnknown: false, retryable: true })
      expect((await f.service().read({ sessionId: 'session' }, signal)).actions[0]).toMatchObject({
        status: 'rejected',
        refusal: { reason: 'unauthorized' },
      })
    },
  )
  it('refuses update/close while approval or uncertain execution is pending', async () => {
    const f = await opened()
    await f.service().action(request(), actor, signal)
    await f.outcome('pending-approval')
    const next = surface()
    next.revision = 2
    await expect(
      f.service().update({ surfaceId: 'reconcile', expectedRevision: 1, surface: next }, signal),
    ).rejects.toMatchObject({ data: { code: 'UI_BUSY' } })
    await expect(
      f.service().close({ surfaceId: 'reconcile', expectedRevision: 1 }, signal),
    ).rejects.toMatchObject({ data: { code: 'UI_BUSY' } })
    await f.outcome('failed', {
      code: 'DEFERRED_OUTCOME_UNKNOWN',
      message: 'Reconcile first',
      retryable: false,
      outcomeUnknown: true,
    })
    expect(await f.service().action({ ...request('retry'), retryOf: 'one' }, actor, signal)).toMatchObject({
      status: 'rejected',
      refusal: { reason: 'invalid' },
    })
    await expect(
      f.service().close({ surfaceId: 'reconcile', expectedRevision: 1 }, signal),
    ).rejects.toMatchObject({ data: { code: 'UI_BUSY' } })
  })
  it('retries a known not-dispatched failure with a new command and revalidates bindings', async () => {
    const f = await opened()
    await f.service().action(request(), actor, signal)
    await f.outcome('failed', {
      code: 'TOOL_DISPATCH_NOT_SENT',
      message: 'Not dispatched',
      retryable: true,
      outcomeUnknown: false,
    })
    expect(await f.service().action({ ...request('retry'), retryOf: 'one' }, actor, signal)).toMatchObject({
      status: 'received',
      retryOf: 'one',
    })
    expect(f.calls.size).toBe(2)
    expect(f.rows.some((row) => row.type.endsWith('action.retried'))).toBe(true)
  })
  it('repairs received-before-queue and terminal-before-delivery crash windows without repeating effects', async () => {
    const f = await opened()
    f.wakeFail(true)
    await f.service().action(request(), actor, signal)
    f.restart()
    f.wakeFail(false)
    await f.service().read({ sessionId: 'session' }, signal)
    expect(f.calls.size).toBe(1)
    f.deliveryFail(true)
    await expect(f.outcome('succeeded')).rejects.toThrow('delivery interrupted')
    f.restart()
    f.deliveryFail(false)
    await f.service().read({ sessionId: 'session' }, signal)
    expect(f.deliveries.size).toBe(1)
    expect(f.calls.size).toBe(1)
  })
  it('records safe failure when queue admission fails and does not replay it on read', async () => {
    const f = await opened()
    f.admissionFail(true)
    expect(await f.service().action(request(), actor, signal)).toMatchObject({
      status: 'failed',
      failure: { retryable: true, outcomeUnknown: false },
    })
    f.restart()
    f.admissionFail(false)
    await f.service().read({ sessionId: 'session' }, signal)
    expect(f.calls.size).toBe(0)
  })
  it('enforces data-only schemas, depth, malformed params, row identity and the durable rolling rate', async () => {
    const f = await opened()
    await expect(
      f.service().action({ ...request(), tool: 'bypass' } as UiActionParams, actor, signal),
    ).rejects.toBeDefined()
    const foreign = surface()
    foreign.id = 'other'
    foreign.actions[0]!.paramsSchema = { $ref: 'https://bad.invalid/schema' }
    await expect(f.service().render({ surface: foreign }, signal)).rejects.toBeDefined()
    const badSurfaces = [surface(), surface(), surface(), surface()]
    badSurfaces[0]!.data.rows = [{ id: 'a' }]
    badSurfaces[1]!.data.chart = [{ label: 1, amount: 12 }]
    for (const [index, candidate] of badSurfaces.entries()) {
      candidate.id = 'invalid' + index
      const chart = candidate.components.find((item) => item.kind === 'chart')!
      if (chart.kind !== 'chart') throw new Error('missing chart')
      if (index >= 2) chart.chartType = 'pie'
      if (index === 2) chart.series.push({ key: 'second', label: 'second' })
      if (index === 3) candidate.data.chart = [{ label: 'a', amount: -1 }]
      expect(validIntelligentSurface(candidate)).toBe(false)
      await expect(f.service().render({ surface: candidate }, signal)).rejects.toBeDefined()
    }
    expect((await f.service().read({ sessionId: 'session' }, signal)).surfaces.map((item) => item.surface.id)).toEqual(['reconcile'])
    for (let i = 0; i < 30; i++)
      await f.service().action({ ...request('bad' + i), revision: 99 }, actor, signal)
    await expect(f.service().action(request('limit'), actor, signal)).rejects.toMatchObject({
      data: { code: 'UI_RATE_LIMIT' },
    })
    f.clock(161000)
    expect(await f.service().action(request('limit'), actor, signal)).toMatchObject({ status: 'received' })
  })
  it('binds cursor pages to a snapshot, filters and expiry without repeating receipts', async () => {
    const f = await opened()
    const second = surface(); second.id = 'second'
    await f.service().render({ surface: second }, signal)
    await f.service().action(request(), actor, signal)
    const first = await f.service().read({ sessionId: 'session', limit: 1 }, signal)
    expect(first.nextCursor).toBeDefined()
    expect(first.actions).toHaveLength(1)
    const updated = surface(); updated.id = 'second'; updated.revision = 2
    await f.service().update({ surfaceId: 'second', expectedRevision: 1, surface: updated }, signal)
    const next = await f.service().read({ sessionId: 'session', limit: 1, cursor: first.nextCursor }, signal)
    expect(next.lastSeq).toBe(first.lastSeq)
    expect(next.surfaces[0]?.surface.revision).toBe(1)
    expect(next.actions).toEqual([])
    for (const params of [{ surfaceId: 'second' }, { limit: 2 }, { cursor: first.nextCursor + 'x' }])
      await expect(f.service().read({ sessionId: 'session', limit: 1, cursor: first.nextCursor, ...params }, signal)).rejects.toMatchObject({ data: { code: 'INVALID_PARAMS' } })
    f.clock(161000)
    await expect(f.service().read({ sessionId: 'session', limit: 1, cursor: first.nextCursor }, signal)).rejects.toMatchObject({ data: { code: 'INVALID_PARAMS' } })
  })
  it('releases closed view capacity while preserving historical identity after restart', async () => {
    const f = fixture()
    for (let i = 0; i < 20; i++) {
      const view = surface()
      view.id = 'view' + i
      view.data.status = 'x'.repeat(28000)
      await f.service().render({ surface: view }, signal)
      await f.service().close({ surfaceId: view.id, expectedRevision: 1 }, signal)
    }
    f.restart()
    let projected = uiProjection.init()
    for (const row of f.rows) projected = uiProjection.apply(projected, row)
    expect(projected).toMatchObject({ surfaces: {} })
    expect((await f.service().read({ sessionId: 'session' }, signal)).surfaces).toEqual([])
    expect((await f.service().read({ sessionId: 'session', surfaceId: 'view0' }, signal)).surfaces[0]?.status).toBe('closed')
    const duplicate = surface(); duplicate.id = 'view0'
    await expect(f.service().render({ surface: duplicate }, signal)).rejects.toMatchObject({ data: { code: 'UI_STALE' } })
    await f.service().render({ surface: surface() }, signal)
    expect((await f.service().read({ sessionId: 'session' }, signal)).surfaces).toHaveLength(1)
  })
  it('projection uses ledger provenance and sequence stamps rather than caller facts', async () => {
    const f = await opened()
    await f.service().action(request(), actor, signal)
    await f.outcome('succeeded')
    let projected = uiProjection.init()
    for (const row of f.rows) projected = uiProjection.apply(projected, row)
    expect(projected).toMatchObject({
      surfaces: { reconcile: { status: 'open' } },
      actions: { one: { receipt: { status: 'succeeded' } } },
    })
    const forged = { ...f.rows[0]!, origin: 'principal' }
    expect(uiProjection.apply(uiProjection.init(), forged)).toEqual(uiProjection.init())
  })
})
