import { describe, expect, it } from 'vitest'
import { defaultIds } from '../src/ids.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { SessionLogImpl, type Timers } from '../src/log/session-log.js'
import type { Event, EventInput, Seq } from '../src/types.js'

const actor = {
  id: 'u',
  org: 'local',
  role: 'owner',
  deptPath: [],
  attrs: {},
} satisfies Event['actor']
const timers: Timers = { setTimeout: () => 0, clearTimeout: () => undefined }
const user = (text: string): EventInput => ({
  actor,
  origin: 'principal',
  trust: 'trusted',
  type: 'user/message',
  data: { content: [{ type: 'text', text }] },
})
const opener = {
  actor,
  agnesVersion: '0.0.1',
  preset: 'standard',
  resolvedProfileHash: null,
  writerRunId: 'child-run',
  lane: 'main',
}

const openParent = (storage: MemoryStorage, key = 'parent', onAppended?: (events: Event[]) => void) =>
  SessionLogImpl.open({
    storage,
    key,
    writerRunId: 'parent-run',
    ttlMs: 900,
    ids: defaultIds(),
    clock: () => Date.now(),
    timers,
    ...(onAppended ? { onAppended } : {}),
  })

const textOf = (event: Event): string | undefined =>
  (event.data as { content?: Array<{ text?: string }> } | null)?.content?.[0]?.text

describe('SessionLogImpl.forkInto', () => {
  it('opens a child on the immutable parent prefix and writes session/start.parent first', async () => {
    const storage = new MemoryStorage()
    const parentEvents: Event[] = []
    const parent = await openParent(storage, 'parent', (events) => parentEvents.push(...events))
    await parent.append([user('one'), user('two'), user('excluded')])

    const child = await parent.forkInto(2, 'child', opener)

    expect(child.parent).toEqual({ key: 'parent', boundarySeq: 2 })
    expect(child.lastSeq).toBe(5)
    const initial = await child.scan({ fromSeq: 1, limit: 10 })
    expect(initial.map((event) => [event.seq, event.type])).toEqual([
      [1, 'user/message'],
      [2, 'user/message'],
      [3, 'session/start'],
      [4, 'budget.state'],
      [5, 'inbox'],
    ])
    expect(initial[2]?.data).toEqual({
      key: 'child',
      parent: { key: 'parent', boundarySeq: 2 },
      resolvedProfileHash: null,
      preset: 'standard',
      agnesVersion: '0.0.1',
    })

    await child.append([user('child-only')])
    expect(parentEvents.map((event) => event.type)).toEqual(['user/message', 'user/message', 'user/message'])
    await parent.append([user('parent-only')])
    expect((await child.scan({ fromSeq: 1, limit: 10 })).map(textOf)).toEqual([
      'one',
      'two',
      undefined,
      undefined,
      undefined,
      'child-only',
    ])
    expect((await parent.scan({ fromSeq: 1, limit: 10 })).map(textOf)).toEqual([
      'one',
      'two',
      'excluded',
      'parent-only',
    ])

    await child.close()
    await parent.close()
  })

  it('rejects invalid boundaries before asking storage to create a child', async () => {
    const storage = new MemoryStorage()
    const parent = await openParent(storage)
    await parent.append([user('one')])
    const createChild = storage.createChild.bind(storage)
    let calls = 0
    storage.createChild = async (...args) => {
      calls += 1
      await createChild(...args)
    }

    for (const boundary of [0, -1, 2, 1.5, Number.NaN] as Seq[]) {
      await expect(parent.forkInto(boundary, `child-${String(boundary)}`, opener)).rejects.toMatchObject({
        code: 'E_SURFACE_RANGE',
      })
    }
    expect(calls).toBe(0)
    await parent.close()
  })

  it('propagates child-key conflicts without changing either ledger', async () => {
    const storage = new MemoryStorage()
    const parent = await openParent(storage)
    await parent.append([user('one'), user('two')])
    const child = await parent.forkInto(1, 'child', opener)
    await child.close()

    await expect(
      parent.forkInto(2, 'child', { ...opener, writerRunId: 'conflicting-child-run' }),
    ).rejects.toMatchObject({ code: 'E_STORAGE_FAULT' })
    const reopened = await parent.forkInto(1, 'child', { ...opener, writerRunId: 'reopened-child-run' })
    expect((await reopened.scan({ fromSeq: 1, limit: 10 })).map((event) => event.type)).toEqual([
      'user/message',
      'session/start',
      'budget.state',
      'inbox',
    ])
    await parent.append([user('parent-still-usable')])
    expect(parent.lastSeq).toBe(3)

    await reopened.close()
    await parent.close()
  })

  it('reopens the same durable fork twice without appending another origin boundary', async () => {
    const storage = new MemoryStorage()
    const parent = await openParent(storage)
    await parent.append([user('one')])
    const first = await parent.forkInto(1, 'child', opener)
    expect(first.latest('op.state')).toBeUndefined()
    expect(first.latest('budget.state')).toBeUndefined()
    expect(first.latest('inbox')).toBeUndefined()
    await first.close()

    const second = await parent.forkInto(1, 'child', { ...opener, writerRunId: 'child-run-2' })
    await second.close()
    const third = await parent.forkInto(1, 'child', { ...opener, writerRunId: 'child-run-3' })
    const own = await third.scan({ fromSeq: 2, limit: 20 })
    expect(own.filter((event) => event.type === 'session/start')).toHaveLength(1)
    expect(own.map((event) => event.type)).toEqual(['session/start', 'budget.state', 'inbox'])

    await third.close()
    await parent.close()
  })

  it('pins current model selections once at the child origin for durable reopen', async () => {
    const storage = new MemoryStorage()
    const parent = await openParent(storage)
    await parent.append([user('one')])
    const selected = {
      ...opener,
      modelSelections: [{ slot: 'primary', route: 'alternate', model: 'model-b' }],
    }
    const first = await parent.forkInto(1, 'child', selected)
    await first.close()
    const reopened = await parent.forkInto(1, 'child', {
      ...selected,
      writerRunId: 'reopened-model-child',
    })
    const switches = await reopened.scan({ type: 'x/core/model-switch', limit: 10 })
    expect(switches).toHaveLength(1)
    expect(switches[0]?.data).toMatchObject({
      slot: 'primary',
      to: { route: 'alternate', model: 'model-b' },
      reason: 'fork-origin',
    })
    await reopened.close()
    await parent.close()
  })

  it('rejects self-forks as an existing-key conflict', async () => {
    const storage = new MemoryStorage()
    const parent = await openParent(storage)
    await parent.append([user('one')])

    await expect(parent.forkInto(1, parent.key, opener)).rejects.toMatchObject({
      code: 'E_STORAGE_FAULT',
    })
    expect((await parent.scan({ fromSeq: 1, limit: 10 })).map(textOf)).toEqual(['one'])
    await parent.close()
  })
})
