import { Context } from '@agnes/cordis'
import type { UITimeline, UiSurfaceRecord } from '@agnes/protocol'
import type { Client } from '@agnes/sdk/browser'
import { expect, it, vi } from 'vitest'
import {
  DeliverablesStore,
  deliveredFiles,
  groupDeliveredFiles,
  surfaceDeliverables,
} from '../src/deliverables.js'
import { SessionService } from '../src/services-session.js'

const artifact = { sha256: 'a'.repeat(64), size: 6, mime: 'text/plain' }
const file = { name: 'report.txt', description: 'final', ref: artifact }
const turns = [{ id: 'turn', startSeq: 1, endSeq: 20 }] as UITimeline['turns']
const record = {
  lane: 'main',
  owner: 'agnes/deliverables',
  createdSeq: 5,
  surface: {
    id: 'card',
    revision: 1,
    placement: { inline: true, workbench: true },
    components: [{ id: 'file-0', kind: 'artifact-file', dataKey: 'file-0' }],
    data: { 'file-0': { name: file.name, description: file.description, artifact } },
  },
} as unknown as UiSurfaceRecord

it('validates full artifact identities and preserves same-byte files under distinct names and snapshot history', () => {
  expect(deliveredFiles([{ ...file, ref: { ...artifact, sha256: '../../secret' } }])).toEqual([])
  const first = surfaceDeliverables('session', record, turns)[0]!
  expect(first).toMatchObject({
    turnId: 'turn',
    sessionId: 'session',
    laneId: 'main',
    source: { owner: 'agnes/deliverables' },
  })
  const second = { ...first, id: 'v2', seq: 9, artifact: { ...artifact, sha256: 'b'.repeat(64) } }
  const renamed = { ...first, id: 'other', name: 'other.txt' }
  const groups = groupDeliveredFiles([first, renamed, second, { ...second, id: 'repeat', seq: 10 }])
  expect(groups.map((group) => group.latest.id)).toEqual(['repeat', 'other'])
  expect(groups[0]?.earlier.map((entry) => entry.artifact.sha256)).toEqual([artifact.sha256])
})

it('recovers durable plain files when Intelligent UI is disabled, refreshes on restart and ignores stale session reads', async () => {
  const ctx = new Context()
  const selected = new SessionService(ctx, 's1')
  const notifications = new Set<(...args: never[]) => void>()
  const lifecycle = new Map<string, () => void>()
  let admitted = false
  const detail = vi.fn(async () => ({
    result: { structured: { deliverables: [file], laneId: 'main', owner: 'agnes/deliverables' } },
  }))
  const handle = {
    id: 's1',
    listeners: notifications,
    projectUI: async () => {
      if (!admitted) throw new Error('SESSION_NOT_FOUND')
      return { turns, nodes: [{ kind: 'tool', name: 'present', seq: 3, resultSeq: 6, toolUseId: 'call' }] }
    },
    uiRead: async () => {
      throw new Error('provider disabled')
    },
    readToolDetail: detail,
  }
  const client = {
    sessions: { get: () => handle },
    on: (name: string, listener: () => void) => {
      lifecycle.set(name, listener)
      return () => lifecycle.delete(name)
    },
  } as unknown as Client
  // A cold browser can mount the role from a history preview before admission completes.
  selected.setSession('s1', 'history-only')
  const store = new DeliverablesStore(client, selected)
  await vi.waitFor(() => expect(store.getSnapshot().loading).toBe(false))
  expect(store.getSnapshot().files).toEqual([])
  selected.setSession('s1', 'connecting')
  admitted = true
  selected.setReadiness('ready')
  await vi.waitFor(() => expect(store.getSnapshot().files).toHaveLength(1))
  expect(store.getSnapshot().files[0]).toMatchObject({ artifact, turnId: 'turn', source: { callSeq: 3 } })
  let beginRead!: () => void
  const entered = new Promise<void>((resolve) => {
    beginRead = resolve
  })
  let finishRead!: (value: Awaited<ReturnType<typeof detail>>) => void
  const late = new Promise<Awaited<ReturnType<typeof detail>>>((resolve) => {
    finishRead = resolve
  })
  detail.mockImplementationOnce(() => {
    beginRead()
    return late
  })
  const pending = store.refresh()
  await entered
  selected.setReadiness('connecting')
  expect(store.getSnapshot().files).toEqual([])
  let stalePublished = false
  const stop = store.subscribe(() => {
    stalePublished ||= store.getSnapshot().files.some((entry) => entry.name === 'stale.txt')
  })
  selected.setReadiness('ready')
  finishRead({
    result: {
      structured: {
        deliverables: [{ ...file, name: 'stale.txt' }],
        laneId: 'main',
        owner: 'agnes/deliverables',
      },
    },
  })
  await pending
  expect(stalePublished).toBe(false)
  expect(store.getSnapshot().files.map((entry) => entry.name)).toEqual(['report.txt'])
  stop()
  // Reconstructing the reader after restart uses the saved result, not a browser cache or source path.
  store.dispose()
  expect(notifications.size).toBe(0)
  const restored = new DeliverablesStore(client, selected)
  await vi.waitFor(() => expect(restored.getSnapshot().files).toHaveLength(1))
  lifecycle.get('reconnected')?.()
  await restored.refresh()
  selected.setSession(undefined)
  expect(restored.getSnapshot().files).toEqual([])
  restored.dispose()
  expect(lifecycle.size).toBe(0)
})

it.each([false, true])(
  'recovers paginated or closed historical surfaces and merges enhanced copies (closed=%s)',
  async (closed) => {
    const ctx = new Context(),
      selected = new SessionService(ctx, 's')
    const read = vi.fn(async (params: { cursor?: string; surfaceId?: string } = {}) => ({
      surfaces: params.surfaceId || (!closed && !params.cursor) ? [record] : [],
      ...(params.cursor || params.surfaceId ? {} : { nextCursor: 'next' }),
    }))
    const client = {
      on: () => () => {},
      sessions: {
        get: () => ({
          id: 's',
          listeners: new Set(),
          projectUI: async () => ({
            turns,
            nodes: [{ kind: 'tool', name: 'present', seq: 3, resultSeq: 6, toolUseId: 'call' }],
          }),
          uiRead: read,
          readToolDetail: async () => ({
            result: { structured: { ...(closed ? {} : { deliverables: [file] }), surfaceId: 'card' } },
          }),
        }),
      },
    } as unknown as Client
    selected.setReadiness('ready')
    const store = new DeliverablesStore(client, selected)
    await vi.waitFor(() => expect(store.getSnapshot().loading).toBe(false))
    expect(read.mock.calls.map(([params]) => params)).toEqual(
      closed ? [{}, { cursor: 'next' }, { surfaceId: 'card' }] : [{}, { cursor: 'next' }],
    )
    expect(store.getSnapshot().files).toHaveLength(1)
    store.dispose()
  },
)
