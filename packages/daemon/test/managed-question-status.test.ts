import type { ScanRead } from '@agnes/host'
import type { EventEnvelope, UiSurface, UiSurfaceRecord } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { hasOpenNativeQuestion } from '../src/supervisor/managed-question-status.js'
import { managedSessionPorts } from '../src/supervisor/managed-session-ports.js'

const prefix = 'x/agnes/intelligent-ui/surface.'

function surface(id = 'question'): UiSurface {
  return {
    id,
    revision: 1,
    title: 'Pick',
    placement: { inline: true, workbench: false, preferred: 'inline' },
    components: [
      {
        id: 'answers',
        kind: 'form',
        dataKey: 'draft',
        actionIds: ['submit'],
        schema: { type: 'object', properties: {}, additionalProperties: false },
      },
    ],
    data: { draft: {}, question: { kind: 'ask_user_question', deadline: 0 } },
    actions: [
      {
        id: 'submit',
        label: 'Submit',
        tool: 'ui_submit',
        argsTemplate: {},
        paramsSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
    ],
  }
}

function record(id = 'question'): UiSurfaceRecord {
  return {
    surface: surface(id),
    status: 'open',
    createdSeq: 0,
    updatedSeq: 0,
    owner: 'plugin/owner',
    lane: 'main',
    taskId: 'task',
  }
}

function event(
  seq: number,
  name: string,
  value: unknown,
  overrides: Partial<EventEnvelope> = {},
): EventEnvelope {
  return {
    v: 1,
    seq,
    ts: '2026-01-01T00:00:00.000Z',
    id: `event-${seq}`,
    actor: { id: 'owner', org: 'local', role: 'owner', deptPath: [], attrs: {} },
    origin: 'ext:agnes/intelligent-ui',
    trust: 'untrusted',
    ignorable: true,
    lane: 'main',
    type: `${prefix}${name}`,
    data: { record: value },
    ...overrides,
  } as unknown as EventEnvelope
}
function ledger(rows: EventEnvelope[]) {
  const calls: Parameters<ScanRead<EventEnvelope>>[0][] = []
  const read: ScanRead<EventEnvelope> = async (q) => {
    calls.push({ ...q })
    const filtered = rows
      .filter(
        (row) =>
          (q.fromSeq === undefined || row.seq >= q.fromSeq) &&
          (q.toSeq === undefined || row.seq <= q.toSeq) &&
          (q.lane === undefined || row.lane === q.lane) &&
          (q.type === undefined || (Array.isArray(q.type) ? q.type.includes(row.type) : q.type === row.type)),
      )
      .sort((a, b) => (q.order === 'desc' ? b.seq - a.seq : a.seq - b.seq))
    return filtered.slice(0, q.limit)
  }
  return { read, calls }
}

const updated = (old: UiSurfaceRecord, changes: Partial<UiSurface> = {}): UiSurfaceRecord => ({
  ...old,
  surface: { ...old.surface, revision: old.surface.revision + 1, ...changes },
})
const closed = (old: UiSurfaceRecord): UiSurfaceRecord => ({ ...old, status: 'closed' })

describe('durable native question projection', () => {
  it('ignores forged origins, other lanes, unrelated surfaces and non-question markers', async () => {
    const ordinary = record('ordinary')
    ordinary.surface.data = { question: { kind: 'different' } }
    const rows = [
      event(1, 'opened', record('forged'), { origin: 'ext:other/plugin' }),
      event(2, 'opened', record('lane'), { lane: 'other' }),
      event(3, 'opened', record('wrong-trust'), { trust: 'trusted' }),
      event(4, 'opened', ordinary),
    ]
    expect(await hasOpenNativeQuestion(ledger(rows).read)).toBe(false)
    rows.push(event(5, 'opened', record('real')))
    expect(await hasOpenNativeQuestion(ledger(rows).read)).toBe(true)
    rows.push(event(6, 'closed', closed(record('real')), { origin: 'ext:other/plugin' }))
    rows.push(event(7, 'closed', closed(record('real')), { lane: 'other' }))
    rows.push(event(8, 'closed', closed(record('real')), { trust: 'trusted' }))
    expect(await hasOpenNativeQuestion(ledger(rows).read)).toBe(true)
  })

  it('tracks question updates and closes without confusing independent surfaces', async () => {
    const first = record('first')
    const second = record('second')
    const noQuestion = updated(first, { data: { draft: {} } })
    const rows = [
      event(1, 'opened', first),
      event(2, 'opened', second),
      event(3, 'updated', noQuestion),
      event(4, 'closed', closed(second)),
    ]
    expect(await hasOpenNativeQuestion(ledger(rows).read)).toBe(false)
    const questionAgain = updated(noQuestion, {
      data: { question: { kind: 'ask_user_question', deadline: 0 } },
    })
    rows.push(event(5, 'updated', questionAgain))
    expect(await hasOpenNativeQuestion(ledger(rows).read)).toBe(true)
    rows.push(event(6, 'closed', closed(questionAgain)))
    expect(await hasOpenNativeQuestion(ledger(rows).read)).toBe(false)
  })

  it.each([
    ['missing record', [event(1, 'opened', null)]],
    ['missing surface data', [event(1, 'opened', { ...record(), surface: { ...surface(), data: null } })]],
    ['wrong record lane', [event(1, 'opened', { ...record(), lane: 'other' })]],
    ['missing task', [event(1, 'opened', { ...record(), taskId: '' })]],
    ['missing owner', [event(1, 'opened', { ...record(), owner: '' })]],
    ['initial revision', [event(1, 'opened', { ...record(), surface: { ...surface(), revision: 2 } })]],
    ['duplicate open', [event(1, 'opened', record()), event(2, 'opened', record())]],
    ['orphan update', [event(1, 'updated', updated(record()))]],
    ['revision gap', [event(1, 'opened', record()), event(2, 'updated', updated(record(), { revision: 3 }))]],
    [
      'changed owner',
      [event(1, 'opened', record()), event(2, 'updated', { ...updated(record()), owner: 'other' })],
    ],
    [
      'changed task',
      [event(1, 'opened', record()), event(2, 'updated', { ...updated(record()), taskId: 'other' })],
    ],
    [
      'changed lane',
      [event(1, 'opened', record()), event(2, 'updated', { ...updated(record()), lane: 'other' })],
    ],
    ['altered close content', [event(1, 'opened', record()), event(2, 'closed', closed(updated(record())))]],
    [
      'update after close',
      [
        event(1, 'opened', record()),
        event(2, 'closed', closed(record())),
        event(3, 'updated', updated(record())),
      ],
    ],
  ] satisfies [string, EventEnvelope[]][])('rejects corrupt surface chains: %s', async (_name, rows) => {
    await expect(hasOpenNativeQuestion(ledger(rows).read)).rejects.toThrow(
      'UI surface ledger chain is corrupt',
    )
  })

  it('pins the head and reads bounded pages even when the ledger grows during the scan', async () => {
    const rows = Array.from({ length: 9 }, (_, i) => {
      const value = record(`q${i}`)
      if (i < 8) value.surface.data = { draft: {} }
      return event(i + 1, 'opened', value)
    })
    const source = ledger(rows)
    const read: ScanRead<EventEnvelope> = async (query) => {
      const page = await source.read(query)
      if (source.calls.length === 1) rows.push(event(10, 'closed', closed(record('q8'))))
      return page
    }
    expect(await hasOpenNativeQuestion(read)).toBe(true)
    expect(source.calls).toEqual([
      { order: 'desc', limit: 1 },
      {
        type: ['opened', 'updated', 'closed'].map((name) => prefix + name),
        lane: 'main',
        toSeq: 9,
        order: 'asc',
        limit: 8,
      },
      {
        type: ['opened', 'updated', 'closed'].map((name) => prefix + name),
        lane: 'main',
        toSeq: 9,
        fromSeq: 9,
        order: 'asc',
        limit: 8,
      },
    ])
  })

  it('propagates head and page read failures and a non-advancing page', async () => {
    const failure = new Error('storage unavailable')
    await expect(
      hasOpenNativeQuestion(async () => {
        throw failure
      }),
    ).rejects.toBe(failure)
    await expect(hasOpenNativeQuestion(async () => [{} as EventEnvelope])).rejects.toThrow(
      'ledger head is corrupt',
    )
    const pageFailure: ScanRead<EventEnvelope> = async (q) => {
      if (q.order === 'desc') return [event(10, 'opened', record())]
      throw failure
    }
    await expect(hasOpenNativeQuestion(pageFailure)).rejects.toBe(failure)
    const repeated = Array.from({ length: 8 }, (_, i) => event(i + 1, 'opened', record(`q${i}`)))
    const lateFailure: ScanRead<EventEnvelope> = async (q) => {
      if (q.order === 'desc') return [event(10, 'opened', record())]
      if (q.fromSeq !== undefined) throw failure
      return repeated
    }
    await expect(hasOpenNativeQuestion(lateFailure)).rejects.toBe(failure)
    const stuck: ScanRead<EventEnvelope> = async (q) =>
      q.order === 'desc' ? [event(10, 'opened', record())] : repeated
    await expect(hasOpenNativeQuestion(stuck)).rejects.toThrow(
      'scan page did not move past the previous page',
    )
  })

  it('reads historical questions without opening workers, and omits the reader when unavailable', async () => {
    const open = vi.fn(async () => {
      throw new Error('worker opened')
    })
    const restoreBinding = vi.fn(async () => {
      throw new Error('binding opened')
    })
    const read = vi.fn(() => ledger([event(1, 'opened', record())]).read)
    const deps = {
      socketPath: '',
      serverIdentity: { pid: 0, processStartId: '' },
      records: {} as never,
      authorize: async () => undefined,
      forkParent: () => undefined,
      workspaces: { restoreBinding } as never,
      models: async () => [],
      registry: { get: () => undefined, open },
      commandQueue: {} as never,
      continueTurn: () => undefined,
      opensWithCommandRules: true,
      osBoundary: async () => false,
    }
    const withReader = managedSessionPorts({ ...deps, sessionFactRead: read })
    expect(await withReader.ports.sessions.openQuestion?.('historical')).toBe(true)
    expect(read).toHaveBeenCalledWith('historical')
    expect(open).not.toHaveBeenCalled()
    expect(restoreBinding).not.toHaveBeenCalled()
    expect(managedSessionPorts(deps).ports.sessions.openQuestion).toBeUndefined()
  })
})
