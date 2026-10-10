import type {
  UiActionParams,
  UiActionReceipt,
  UiReadParams,
  UiReadResult,
  UiSurfaceRecord,
} from '@agnes/protocol/gen/intelligent-ui'
import { describe, expect, it } from 'vitest'
import { IntelligentUiClient } from '../../src/intelligent-ui/client.js'
import type { IntelligentUiServer, UiCommandStorage } from '../../src/intelligent-ui/types.js'
import { financeRecord, uiPage, uiReceipt } from './fixture.js'

class FakeServer implements IntelligentUiServer {
  page = uiPage()
  submitted: UiActionParams[] = []
  next: UiActionReceipt | Error = uiReceipt('received')
  onEvent: ((event: { seq: number; type: string }) => void) | undefined
  onGap: (() => void) | undefined
  attached?: number
  readOverride?: (params: UiReadParams) => Promise<UiReadResult>
  read = async (params: UiReadParams) =>
    this.readOverride
      ? this.readOverride(params)
      : params.commandId
        ? {
            ...this.page,
            surfaces: [],
            actions: this.page.actions.filter((item) => item.commandId === params.commandId),
          }
        : this.page
  action = async (params: UiActionParams) => {
    this.submitted.push(structuredClone(params))
    if (this.next instanceof Error) throw this.next
    return { ...this.next, commandId: params.commandId, revision: params.revision }
  }
  listen(onEvent: NonNullable<FakeServer['onEvent']>, onGap: () => void) {
    this.onEvent = onEvent
    this.onGap = onGap
    return () => {
      this.onEvent = undefined
      this.onGap = undefined
    }
  }
  attach = async (seq: number) => {
    this.attached = seq
  }
  refreshed?: UiSurfaceRecord
  refresh = async () => this.refreshed ?? structuredClone(this.page.surfaces[0]!)
}
const storage = (): UiCommandStorage => {
  const map = new Map<string, string>()
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value)
    },
    removeItem: (key) => {
      map.delete(key)
    },
  }
}
async function setup(store?: UiCommandStorage) {
  const server = new FakeServer()
  let n = 0
  const client = new IntelligentUiClient('session-finance', server, store, () => `command-${++n}`)
  await client.start()
  return { client, server, id: 'finance-review', action: financeRecord().surface.actions[0]! }
}

describe('Intelligent UI session projection and commands', () => {
  it('shares drafts, freezes before transport and never dispatches a duplicate click', async () => {
    const { client, server, id, action } = await setup()
    client.setSelection(id, 'differences', ['txn-1'])
    client.setInput(id, 'adjustment', { reason: 'Reviewed' })
    expect(client.draft(id).input.adjustment).toEqual({ reason: 'Reviewed' })
    client.choose(id, action)
    await Promise.all([client.confirm(id), client.confirm(id)])
    expect(server.submitted).toEqual([
      {
        sessionId: 'session-finance',
        surfaceId: id,
        revision: 1,
        actionId: 'confirm',
        commandId: 'command-1',
        input: { adjustment: { reason: 'Reviewed' } },
        selection: { differences: ['txn-1'] },
        confirmed: true,
      },
    ])
    expect(client.receipts(id)[0]?.status).toBe('received')
    expect(client.locked(id)).toBe(true)
    client.dispose()
  })

  it('recovers an interrupted command after reload and resends the immutable identity', async () => {
    const store = storage(),
      { client, server, id, action } = await setup(store)
    server.next = new Error('transport lost')
    client.choose(id, action)
    await client.confirm(id)
    expect(client.getSnapshot().error).toBe('ui.transport')
    const original = server.submitted[0]
    client.dispose()
    const restored = new IntelligentUiClient('session-finance', server, store)
    await restored.start()
    expect(restored.locked(id)).toBe(true)
    server.next = uiReceipt('pending-approval', { duplicate: true })
    await restored.resend(id)
    expect(server.submitted[1]).toEqual(original)
    expect(restored.receipts(id)[0]).toMatchObject({
      status: 'pending-approval',
      invocationId: 'invocation-1',
      approvalId: 'approval-1',
      duplicate: true,
    })
    restored.dispose()
  })

  it.each(['received', 'pending-approval', 'executing', 'succeeded', 'failed', 'rejected'] as const)(
    'recovers %s from durable receipts',
    async (status) => {
      const { client, server, id } = await setup()
      server.page = uiPage(financeRecord(), [uiReceipt(status)], 20)
      await client.refresh()
      expect(client.receipts(id)[0]?.status).toBe(status)
      expect(client.locked(id)).toBe(['received', 'pending-approval', 'executing'].includes(status))
      client.dispose()
    },
  )

  it('preserves old failed attempts and creates a fresh command with retryOf', async () => {
    const { client, server, id, action } = await setup()
    server.page = uiPage(financeRecord(), [uiReceipt('failed', { commandId: 'old-command' })], 20)
    await client.refresh()
    client.choose(id, action, undefined, 'old-command')
    await client.confirm(id)
    expect(server.submitted[0]).toMatchObject({ commandId: 'command-1', retryOf: 'old-command' })
    expect(client.receipts(id).find((item) => item.commandId === 'old-command')?.status).toBe('failed')
    client.dispose()
  })

  it('keeps unknown effects locked and refuses unsafe retry', async () => {
    const { client, server, id, action } = await setup()
    server.page = uiPage(
      financeRecord(),
      [
        uiReceipt('failed', {
          failure: { code: 'GAP', message: 'Receipt missing', retryable: false, outcomeUnknown: true },
        }),
      ],
      20,
    )
    await client.refresh()
    client.choose(id, action, undefined, 'command-1')
    await client.confirm(id)
    expect(client.locked(id)).toBe(true)
    expect(server.submitted).toEqual([])
    client.dispose()
  })

  it.each(['stale', 'closed'] as const)(
    'requires current data review after %s without replaying old input',
    async (reason) => {
      const { client, server, id, action } = await setup()
      server.next = uiReceipt('rejected', {
        refusal: {
          reason,
          code: reason === 'stale' ? 'UI_STALE' : 'UI_CLOSED',
          message: 'Changed',
          currentRevision: 2,
        },
      })
      server.page = uiPage({ ...financeRecord(2), status: reason === 'closed' ? 'closed' : 'open' }, [], 20)
      client.setInput(id, 'adjustment', { reason: 'Old edit' })
      client.choose(id, action)
      await client.confirm(id)
      expect(client.needsReview(id)).toBe(true)
      expect(client.draft(id).input.adjustment).toEqual({ reason: 'Updated difference' })
      await client.review(id)
      expect(client.locked(id)).toBe(reason === 'closed')
      await client.refresh()
      expect(client.needsReview(id)).toBe(false)
      if (reason === 'stale') {
        server.next = uiReceipt('succeeded', { revision: 2 })
        client.choose(id, action)
        expect(client.confirmation(id)?.revision).toBe(2)
        await client.confirm(id)
        expect(server.submitted.at(-1)).toMatchObject({
          revision: 2,
          input: { adjustment: { reason: 'Updated difference' } },
          confirmed: true,
        })
        expect(client.receipts(id).some((receipt) => receipt.status === 'succeeded')).toBe(true)
      }
      client.dispose()
    },
  )

  it('buffers live events while reading consistent snapshot pages, then reads current facts', async () => {
    const server = new FakeServer()
    server.readOverride = async (params) => {
      if (params.cursor)
        return { ...uiPage(financeRecord(), [uiReceipt('received', { seq: 9 })], 10), surfaces: [] }
      if (!server.attached) {
        server.onEvent?.({ seq: 11, type: 'x/agnes/intelligent-ui/surface.updated' })
        return { ...uiPage(financeRecord(), [uiReceipt('received', { seq: 9 })], 10), nextCursor: 'page-2' }
      }
      return uiPage(financeRecord(2), [], 11)
    }
    const client = new IntelligentUiClient('session-finance', server)
    await client.start()
    await client.refresh()
    expect(server.attached).toBe(10)
    expect(client.record('finance-review')?.surface.revision).toBe(2)
    client.dispose()
    expect(server.onEvent).toBeUndefined()
  })

  it('fails closed for missing approval/result evidence, changing watermarks and bad surface data', async () => {
    const { client, server, id } = await setup()
    for (const receipt of [
      uiReceipt('pending-approval', { approvalId: '' }),
      uiReceipt('succeeded', { resultSeq: 0 }),
    ]) {
      server.page = uiPage(financeRecord(), [receipt], 20)
      await client.refresh()
      expect(client.getSnapshot().ready).toBe(false)
      expect(client.locked(id)).toBe(true)
    }
    server.readOverride = async (params) =>
      params.cursor ? { ...uiPage(), lastSeq: 11 } : { ...uiPage(), nextCursor: 'next' }
    await client.refresh()
    expect(client.getSnapshot().ready).toBe(false)
    client.dispose()
  })

  it('does not overwrite the original receipt when transport reports a command conflict', async () => {
    const { client, server, id, action } = await setup()
    server.next = Object.assign(new Error('conflict'), { data: { code: 'UI_COMMAND_CONFLICT' } })
    client.choose(id, action)
    await client.confirm(id)
    expect(client.getSnapshot().error).toBe('ui.duplicate')
    server.page = uiPage(financeRecord(), [uiReceipt('succeeded')], 20)
    await client.resend(id)
    expect(client.receipts(id)[0]?.status).toBe('succeeded')
    expect(server.submitted).toHaveLength(1)
    client.dispose()
  })
  it('requires explicit row identity for a safe row retry after reload', async () => {
    const { client, server, id, action } = await setup()
    const record = financeRecord()
    const table = record.surface.components.find((item) => item.kind === 'table')!
    if ('fallback' in table || table.kind !== 'table') throw new Error('Missing table fixture')
    table.rowActionIds = ['confirm']
    server.page = uiPage(record, [uiReceipt('failed', { commandId: 'old-row-command' })], 20)
    await client.refresh()
    client.retry(client.receipts(id)[0]!)
    expect(client.getSnapshot().error).toBe('ui.retryRow')
    expect(client.confirmation(id)).toBeUndefined()
    client.choose(id, action, { tableId: 'differences', rowId: 'txn-1' })
    await client.confirm(id)
    expect(server.submitted[0]).toMatchObject({
      retryOf: 'old-row-command',
      row: { tableId: 'differences', rowId: 'txn-1' },
      selection: { differences: ['txn-1'] },
    })
    client.dispose()
  })

  it('copies a resolved form object and never a source binding', async () => {
    const { client, id } = await setup()
    expect(client.draft(id).input.adjustment).toEqual({ reason: 'Mismatch' })
    client.dispose()
    const server = new FakeServer()
    const bound = financeRecord()
    bound.surface.data.draft = { $source: 'finance/differences', params: {} }
    bound.sources = { draft: { status: 'error', code: 'UI_SOURCE_DENIED' } }
    server.page = uiPage(bound)
    const denied = new IntelligentUiClient('session-finance', server)
    await denied.start()
    expect(denied.draft(id).input.adjustment).toBeUndefined()
    expect(JSON.stringify(denied.draft(id))).not.toContain('$source')
    denied.dispose()
  })

  it('submits the ready source hash and replaces that surface on refresh', async () => {
    const { client, server, id, action } = await setup()
    const hash = 'ab'.repeat(32)
    const record = financeRecord()
    record.sources = { rows: { status: 'ready', resultHash: hash } }
    server.page = uiPage(record, [], 20)
    await client.refresh()
    const refreshed = financeRecord()
    refreshed.surface.data.rows = [{ id: 'txn-2', amountCents: 9 }]
    refreshed.sources = { rows: { status: 'ready', resultHash: 'cd'.repeat(32) } }
    server.refreshed = refreshed
    await client.refreshSource(id)
    expect(client.record(id)?.surface.revision).toBe(1)
    expect(client.record(id)?.surface.data.rows).toEqual([{ id: 'txn-2', amountCents: 9 }])
    expect(client.record(id)?.sources?.rows).toEqual({ status: 'ready', resultHash: 'cd'.repeat(32) })
    client.choose(id, action)
    await client.confirm(id)
    expect(server.submitted[0]?.sources).toEqual({ rows: 'cd'.repeat(32) })
    client.dispose()
  })
})
