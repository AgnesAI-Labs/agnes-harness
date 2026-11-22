import type { CallContext, Handler, LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { attachmentLink, type EventEnvelope, rpcError, sessionArtifactRoots } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { artifactHistoryReader, registerWorkerSessionReads } from '../src/supervisor/session-reads.js'

const stored = { sessionId: 's-1', readOnly: true, lastSeq: 3, source: 'stored' }
const hosted = { sessionId: 's-1', readOnly: true, lastSeq: 3, source: 'worker' }

function mount(options: { viewRead?: Parameters<typeof registerWorkerSessionReads>[3]; owner?: () => void }) {
  const handlers = new Map<string, Handler>()
  const endpoint = { register: (method: string, handler: Handler) => handlers.set(method, handler) }
  const command = vi.fn(async () => hosted)
  const pool = { acquireSharedWorker: vi.fn(async () => ({ command })) }
  const requireOwner = vi.fn(options.owner ?? (() => undefined))
  registerWorkerSessionReads(
    endpoint as unknown as LocalEndpoint,
    pool as never,
    requireOwner,
    options.viewRead,
  )
  const context = { signal: new AbortController().signal } as CallContext
  const view = (params: unknown) => (handlers.get('_agnes/v1/session.view') as Handler)(params, context)
  return { view, pool, command, requireOwner, context }
}

describe('session.view', () => {
  it('answers from the stored ledger without starting a worker', async () => {
    const viewRead = vi.fn(async () => stored)
    const { view, pool, requireOwner, context } = mount({ viewRead })
    pool.acquireSharedWorker.mockRejectedValue(new Error('no worker may start for a preview'))
    await expect(view({ sessionId: 's-1', maxNodes: 20 })).resolves.toBe(stored)
    expect(requireOwner).toHaveBeenCalledWith('session.view', 's-1', context)
    expect(viewRead).toHaveBeenCalledWith('s-1', { maxNodes: 20, signal: context.signal })
    expect(pool.acquireSharedWorker).not.toHaveBeenCalled()
  })

  it('falls back to the worker when the stored read fails', async () => {
    const viewRead = vi.fn(async () => {
      throw new Error('stored read failed')
    })
    const { view, command } = mount({ viewRead })
    await expect(view({ sessionId: 's-1' })).resolves.toBe(hosted)
    expect(command).toHaveBeenCalledWith('session.view', { sessionId: 's-1' })
  })

  it('reports a session the ledger does not have as not found', async () => {
    const viewRead = vi.fn(async () => {
      throw Object.assign(new Error('no such session'), { code: 'E_SESSION_NOT_FOUND' })
    })
    const { view, pool } = mount({ viewRead })
    await expect(view({ sessionId: 's-1' })).rejects.toMatchObject({
      data: { code: 'SESSION_NOT_FOUND', sessionId: 's-1' },
    })
    expect(pool.acquireSharedWorker).not.toHaveBeenCalled()
  })

  it('refuses a session the caller does not own before reading anything', async () => {
    const viewRead = vi.fn(async () => stored)
    const { view, pool } = mount({
      viewRead,
      owner: () => {
        throw rpcError('CAPABILITY_DENIED', { sessionId: 'foreign' })
      },
    })
    await expect(view({ sessionId: 'foreign' })).rejects.toMatchObject({
      data: { code: 'CAPABILITY_DENIED' },
    })
    expect(viewRead).not.toHaveBeenCalled()
    expect(pool.acquireSharedWorker).not.toHaveBeenCalled()
  })

  it('reads through the worker when no stored reader is configured', async () => {
    const { view, command } = mount({})
    await expect(view({ sessionId: 's-1', maxNodes: 5 })).resolves.toBe(hosted)
    expect(command).toHaveBeenCalledWith('session.view', { sessionId: 's-1', maxNodes: 5 })
  })
})

describe('recorded artifact history', () => {
  const common = {
    ts: '2026-01-01T00:00:00Z',
    v: 1,
    trust: 'trusted' as const,
    actor: { id: 'local', org: '', role: '', deptPath: [], attrs: {} },
  }
  const artifactRow = (seq: number, lane = 'main', shaByte = seq) =>
    ({
      ...common,
      seq,
      lane,
      id: `01ARZ3NDEKTSV4RRFFQ69G${String(seq).padStart(4, '0')}`,
      type: 'x/core/artifact.registered',
      origin: 'system',
      ignorable: true,
      data: {
        artifact: {
          sha256: shaByte.toString(16).padStart(64, '0'),
          size: 16,
          mime: 'image/png',
        },
      },
    }) as unknown as EventEnvelope
  const plainToolResult = (seq: number, lane = 'main', textBytes = 1024) =>
    ({
      ...common,
      seq,
      lane,
      id: `01BRZ3NDEKTSV4RRFFQ69G${String(seq % 10000).padStart(4, '0')}`,
      type: 'tool/result',
      origin: 'tool:read',
      data: {
        toolUseId: `u-${seq}`,
        isError: false,
        content: [{ type: 'text', text: 'x'.repeat(textBytes) }],
        enforcement: { level: 'full', scope: [] },
        authz: { decisionId: 'n/a' },
      },
    }) as unknown as EventEnvelope

  it('keeps the initial ledger head and requested lane while ignoring >4096 and >4MiB non-artifact rows and compacting upgraded roots', async () => {
    const first = artifactRow(1, 'main', 1)
    const noisyMain = Array.from({ length: 4200 }, (_, i) => plainToolResult(i + 2, 'main', 1200))
    const largeSameLane = {
      ...common,
      seq: 4202,
      lane: 'main',
      id: '01BRZ3NDEKTSV4RRFFQ69G4202',
      type: 'tool/result',
      origin: 'tool:read',
      data: {
        toolUseId: 'u-large',
        isError: false,
        content: Array.from({ length: 6 }, () => ({ type: 'text', text: 'x'.repeat(750_000) })),
        enforcement: { level: 'full', scope: [] },
        authz: { decisionId: 'n/a' },
      },
    } as unknown as EventEnvelope
    const hugeOtherLane = plainToolResult(4203, 'other', 900_000)
    const latest = artifactRow(4204, 'main', 2)
    const postHead = artifactRow(4205, 'main', 3)
    const all = [first, ...noisyMain, largeSameLane, hugeOtherLane, latest, postHead]
    const seenLanes: (string | undefined)[] = []
    const reader = artifactHistoryReader(() => async (query) => {
      if (!query.type) return [latest]
      seenLanes.push(query.lane)
      return all
        .filter((e) => e.seq >= (query.fromSeq ?? 1) && e.seq <= (query.toSeq ?? 0))
        .slice(0, query.limit)
    })
    const history = await reader.read('recorded', 'main', new AbortController().signal)
    expect(seenLanes.every((lane) => lane === 'main')).toBe(true)
    expect(history).toEqual([first, latest])

    // 2,049 distinct roots appearing first unsized and later sized across >4,096 rows must compact cleanly without retaining message text.
    const count = 2049
    const upgradedRows: EventEnvelope[] = []
    for (let i = 0; i < count; i++) {
      const seq = i + 1
      const sha256 = (i + 1).toString(16).padStart(64, '0')
      upgradedRows.push({
        ...common,
        seq,
        lane: 'main',
        id: `01CRZ3NDEKTSV4RRFFQ69G${String(seq).padStart(4, '0')}`,
        type: 'tool/result',
        origin: 'tool:present',
        data: {
          toolUseId: `p-${seq}`,
          isError: false,
          content: [
            { type: 'resource_link', name: 'doc', uri: `artifact://${sha256}`, mimeType: 'text/plain' },
          ],
          enforcement: { level: 'full', scope: [] },
          authz: { decisionId: 'n/a' },
        },
      } as unknown as EventEnvelope)
    }
    const heavyText = 'm'.repeat(16_384)
    for (let i = 0; i < count; i++) {
      const seq = count + i + 1
      const sha256 = (i + 1).toString(16).padStart(64, '0')
      upgradedRows.push({
        ...common,
        seq,
        lane: 'main',
        id: `01DRZ3NDEKTSV4RRFFQ69G${String(seq).padStart(4, '0')}`,
        type: 'user/message',
        origin: 'principal',
        data: {
          content: [
            { type: 'text', text: heavyText },
            attachmentLink({ sha256, size: 32, mime: 'text/plain' }, 'doc.txt'),
          ],
        },
      } as unknown as EventEnvelope)
    }
    const upgradedReader = artifactHistoryReader(() => async (query) => {
      if (!query.type) return [upgradedRows.at(-1) as EventEnvelope]
      return upgradedRows
        .filter((e) => e.seq >= (query.fromSeq ?? 1) && e.seq <= (query.toSeq ?? 0))
        .slice(0, query.limit)
    })
    const compacted = await upgradedReader.read('upgraded', 'main', new AbortController().signal)
    expect(compacted).toHaveLength(count)
    expect(Buffer.byteLength(JSON.stringify(compacted), 'utf8')).toBeLessThan(1_000_000)
    expect(
      compacted.flatMap((e) => sessionArtifactRoots(e as EventEnvelope) ?? []).every((r) => r.size === 32),
    ).toBe(true)
  })

  it.each([
    'root limit',
    'byte limit',
    'conflicting size',
    'invalid order',
    'scan failure',
    'cancelled',
  ] as const)('refuses a history read on %s', async (mode) => {
    const ac = new AbortController()
    const reader = artifactHistoryReader(() => async (query) => {
      if (!query.type) return [artifactRow(5000)]
      if (mode === 'scan failure') throw new Error('private adapter detail')
      if (mode === 'cancelled') ac.abort()
      if (mode === 'byte limit')
        return [
          {
            ...artifactRow(1),
            data: { artifact: 'x'.repeat(17 * 1024 * 1024) },
          } as unknown as EventEnvelope,
        ]
      if (mode === 'conflicting size')
        return [
          artifactRow(1, 'main', 7),
          {
            ...artifactRow(2, 'main', 7),
            data: { artifact: { sha256: (7).toString(16).padStart(64, '0'), size: 99, mime: 'image/png' } },
          } as unknown as EventEnvelope,
        ]
      if (mode === 'invalid order') return [artifactRow(2), artifactRow(1)]
      return Array.from({ length: 100 }, (_, i) => artifactRow((query.fromSeq ?? 1) + i))
    })
    await expect(reader.read('recorded', 'main', ac.signal)).rejects.toThrow()
  })
})
