import { SessionPreferencesStore } from '@agnes/daemon-foundation/storage/session-preferences'
import { CommandQueue } from '@agnes/daemon-rpc/local/command-queue'
import { createFollowUpRunner } from '@agnes/daemon-rpc/local/follow-up-runner'
import type { ScanRead } from '@agnes/host'
import type { Actor, EventEnvelope } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openTestHost, say } from '../../daemon-rpc/test/host.js'
import { type ManagedInputEntry, managedInputPorts } from '../src/supervisor/managed-input-ports.js'
import { createIdleSignal } from '../src/supervisor/managed-session-idle.js'

type Query = Parameters<ScanRead<EventEnvelope>>[0]
type Fact = { seq: number; type: string; origin?: string; data: unknown }

const actor: Actor = { id: 'plugin:acme/probe', org: 'plugin', role: 'trigger', deptPath: [], attrs: {} }
const input = (dedupe: boolean) => ({ text: 'Owner said hello.', actor, commandId: 'cmd-1', dedupe })

/** A session ledger that answers scans the way core does: by type, lane, range, order and limit. */
function ledger(facts: Fact[]) {
  const queries: Query[] = []
  const scan = async (query: Query) => {
    queries.push(query)
    const types = query.type === undefined ? undefined : ([] as string[]).concat(query.type)
    let rows = facts.filter(
      (fact) =>
        (!types || types.includes(fact.type)) &&
        (query.fromSeq === undefined || fact.seq >= query.fromSeq) &&
        (query.toSeq === undefined || fact.seq <= query.toSeq),
    )
    if (query.order === 'desc') rows = rows.reverse()
    return rows.slice(0, query.limit ?? rows.length).map((fact) => ({ lane: 'main', ...fact }) as never)
  }
  return { facts, queries, scan }
}

function world(facts: Fact[] = [], options: { factRead?: boolean } = {}) {
  const log = ledger(facts)
  const removed: { itemId: string; actor: Actor; admissionId: string }[] = []
  const entry = {
    key: 'session-1',
    ac: new AbortController(),
    inflight: null as unknown,
    session: {
      enqueue: vi.fn(async (_target: 'next-turn', _message: unknown, _options?: unknown) => 41),
      scan: vi.fn(log.scan),
      removeQueuedInput: vi.fn(async (itemId: string, by: Actor, admissionId: string) => {
        removed.push({ itemId, actor: by, admissionId })
        const inbox = facts.findLast((fact) => fact.type === 'inbox')
        const items = (inbox?.data as { items: { itemId: string }[] } | undefined)?.items ?? []
        if (!items.some((item) => item.itemId === itemId))
          throw new Error('queued input is no longer pending')
        facts.push({
          seq: facts.length + 1,
          type: 'inbox',
          data: { items: items.filter((i) => i.itemId !== itemId) },
        })
        return facts.length
      }),
    },
  }
  const opened: string[] = []
  const continued: unknown[] = []
  const preferences = new SessionPreferencesStore()
  const commandQueue = new CommandQueue()
  const ports = managedInputPorts({
    open: async (sessionId) => {
      opened.push(sessionId)
      return entry
    },
    commandQueue,
    continueTurn: (queued) => continued.push(queued),
    preferences,
    ...(options.factRead ? { sessionFactRead: () => log.scan } : {}),
  })
  return { ports, entry, log, removed, opened, continued, preferences, commandQueue }
}

const queues: CommandQueue[] = []
afterEach(async () => {
  await Promise.all(queues.splice(0).map((queue) => queue.close()))
})

describe('managed input ports', () => {
  it('submitInput without dedupe enqueues follow_up with ifEmpty and no dedupeByCommandId', async () => {
    const w = world()
    queues.push(w.commandQueue)
    expect(await w.ports.submitInput('session-1', input(false))).toEqual({ state: 'submitted', seq: 41 })
    const [target, message, options] = w.entry.session.enqueue.mock.calls[0] ?? []
    expect(target).toBe('next-turn')
    expect(message).toEqual({
      content: [{ type: 'text', text: 'Owner said hello.' }],
      actor,
      origin: 'system',
      trust: 'untrusted',
      kind: 'follow_up',
      commandId: 'cmd-1',
      ifEmpty: true,
    })
    expect(options, 'a first submission never scans the whole inbox').toEqual({})
    expect(w.continued, 'the turn is started after the input is queued').toEqual([w.entry])
  })

  it('submitInput with dedupe passes dedupeByCommandId and returns the existing seq', async () => {
    const w = world()
    queues.push(w.commandQueue)
    w.entry.session.enqueue.mockResolvedValueOnce(7)
    expect(await w.ports.submitInput('session-1', input(true))).toEqual({ state: 'submitted', seq: 7 })
    expect(w.entry.session.enqueue.mock.calls[0]?.[2]).toEqual({ dedupeByCommandId: true })
    expect(w.continued, 'a pending item left by a restart is started again').toEqual([w.entry])
  })

  it('submitInput returns busy while inflight and on a competing pending input', async () => {
    const w = world()
    queues.push(w.commandQueue)
    w.entry.inflight = { promptId: 'prompt' }
    expect(await w.ports.submitInput('session-1', input(false))).toEqual({ state: 'busy' })
    expect(w.entry.session.enqueue).not.toHaveBeenCalled()
    w.entry.inflight = null
    w.entry.session.enqueue.mockRejectedValueOnce(new Error('continuation input competed with pending input'))
    expect(await w.ports.submitInput('session-1', input(false))).toEqual({ state: 'busy' })
    expect(w.continued, 'a busy answer starts nothing').toEqual([])
    w.entry.session.enqueue.mockRejectedValueOnce(new Error('session closed'))
    await expect(w.ports.submitInput('session-1', input(false))).rejects.toThrow('session closed')
  })

  it('findUserMessage scans user/message from fromSeq and takes turn from the next turn/start', async () => {
    const w = world([
      { seq: 3, type: 'user/message', origin: 'system', data: { commandId: 'cmd-1' } },
      { seq: 9, type: 'user/message', origin: 'principal', data: { commandId: 'cmd-1' } },
      { seq: 10, type: 'turn/start', data: { turn: 4 } },
      { seq: 12, type: 'user/message', origin: 'system', data: { commandId: 'other' } },
      { seq: 13, type: 'turn/start', data: { turn: 5 } },
      { seq: 15, type: 'user/message', origin: 'system', data: { commandId: 'cmd-1' } },
      { seq: 16, type: 'turn/start', data: { turn: 6 } },
    ])
    queues.push(w.commandQueue)
    expect(await w.ports.findUserMessage('session-1', 'cmd-1', 5)).toEqual({ seq: 15, turn: 6 })
    expect(w.log.queries[0], 'the scan starts at the submitted seq').toMatchObject({
      type: 'user/message',
      lane: 'main',
      fromSeq: 5,
    })
    expect(w.log.queries[1]).toMatchObject({ type: 'turn/start', lane: 'main', fromSeq: 15, limit: 1 })
    expect(await w.ports.findUserMessage('session-1', 'cmd-1', 16)).toBeUndefined()
    expect(await w.ports.findUserMessage('session-1', 'missing', 1)).toBeUndefined()
  })

  it('withdraw removes the queued item by commandId; reports taken once a turn took it; absent when unknown', async () => {
    const w = world([
      {
        seq: 1,
        type: 'inbox',
        data: {
          items: [
            { itemId: 'item-a', commandId: 'other' },
            { itemId: 'item-b', commandId: 'cmd-1' },
          ],
        },
      },
    ])
    queues.push(w.commandQueue)
    expect(await w.ports.withdraw('session-1', 'cmd-1')).toBe('withdrawn')
    expect(w.removed).toEqual([
      {
        itemId: 'item-b',
        actor: expect.objectContaining({ id: expect.any(String) }),
        admissionId: expect.any(String),
      },
    ])
    expect(w.removed[0]?.admissionId).toContain('cmd-1')
    expect(await w.ports.withdraw('session-1', 'cmd-1'), 'gone and never run').toBe('absent')

    w.log.facts.push(
      { seq: 3, type: 'user/message', origin: 'system', data: { commandId: 'cmd-2' } },
      { seq: 4, type: 'turn/start', data: { turn: 1 } },
    )
    expect(await w.ports.withdraw('session-1', 'cmd-2')).toBe('taken')
    expect(await w.ports.withdraw('session-1', 'unknown')).toBe('absent')
  })

  it('queued reads the latest inbox fact for the commandId', async () => {
    const w = world([
      { seq: 1, type: 'inbox', data: { items: [{ itemId: 'item-a', commandId: 'cmd-1' }] } },
      { seq: 2, type: 'inbox', data: { items: [{ itemId: 'item-b', commandId: 'cmd-2' }] } },
    ])
    queues.push(w.commandQueue)
    expect(await w.ports.queued?.('session-1', 'cmd-2')).toBe(true)
    expect(await w.ports.queued?.('session-1', 'cmd-1'), 'only in an older inbox fact').toBe(false)
    expect(await w.ports.queued?.('session-1', 'missing')).toBe(false)
  })

  it('withdraw that loses the race to a turn reports taken', async () => {
    const w = world([{ seq: 1, type: 'inbox', data: { items: [{ itemId: 'item-b', commandId: 'cmd-1' }] } }])
    queues.push(w.commandQueue)
    w.entry.session.removeQueuedInput.mockImplementationOnce(async () => {
      w.log.facts.push(
        { seq: 2, type: 'inbox', data: { items: [] } },
        { seq: 3, type: 'user/message', origin: 'system', data: { commandId: 'cmd-1' } },
        { seq: 4, type: 'turn/start', data: { turn: 1 } },
      )
      throw new Error('queued input is no longer pending')
    })
    expect(await w.ports.withdraw('session-1', 'cmd-1')).toBe('taken')
    w.entry.session.removeQueuedInput.mockRejectedValueOnce(new Error('session closed'))
    w.log.facts.push({ seq: 5, type: 'inbox', data: { items: [{ itemId: 'item-c', commandId: 'cmd-3' }] } })
    await expect(w.ports.withdraw('session-1', 'cmd-3')).rejects.toThrow('session closed')
  })

  it('archived reads session preferences, so an owner archive in the Web counts', () => {
    const w = world()
    queues.push(w.commandQueue)
    expect(w.ports.archived('session-1')).toBe(false)
    w.preferences.archive('session-1', true)
    expect(w.ports.archived('session-1')).toBe(true)
    w.preferences.archive('session-1', false)
    expect(w.ports.archived('session-1')).toBe(false)
    expect(w.opened, 'reading the archive state opens no session').toEqual([])
  })

  it('lastTurnEnd reports reason and whether a turn started after it', async () => {
    const empty = world()
    queues.push(empty.commandQueue)
    expect(await empty.ports.lastTurnEnd('session-1')).toBeUndefined()
    const w = world([
      { seq: 2, type: 'turn/start', data: { turn: 1 } },
      { seq: 5, type: 'turn/end', data: { reason: 'completed' } },
      { seq: 6, type: 'turn/start', data: { turn: 2 } },
      { seq: 9, type: 'turn/end', data: { reason: 'cancelled' } },
    ])
    queues.push(w.commandQueue)
    expect(await w.ports.lastTurnEnd('session-1')).toEqual({ seq: 9, reason: 'cancelled', laterStart: false })
    w.log.facts.push({ seq: 10, type: 'turn/start', data: { turn: 3 } })
    expect(await w.ports.lastTurnEnd('session-1')).toEqual({ seq: 9, reason: 'cancelled', laterStart: true })
  })

  it('reads the ledger without opening the session when a fact reader is present', async () => {
    const w = world(
      [
        { seq: 1, type: 'user/message', origin: 'system', data: { commandId: 'cmd-1' } },
        { seq: 2, type: 'turn/start', data: { turn: 1 } },
        { seq: 3, type: 'turn/end', data: { reason: 'completed' } },
      ],
      { factRead: true },
    )
    queues.push(w.commandQueue)
    expect(await w.ports.findUserMessage('session-1', 'cmd-1', 1)).toEqual({ seq: 1, turn: 1 })
    expect(await w.ports.lastTurnEnd('session-1')).toEqual({ seq: 3, reason: 'completed', laterStart: false })
    expect(w.opened).toEqual([])
    expect(w.entry.session.scan).not.toHaveBeenCalled()
  })
})

describe('managed input ports on a real session', () => {
  it('withdraws a queued input, and a dedupe resubmission after a restart runs it exactly once', async () => {
    const h = await openTestHost({ script: [say('managed answer')] })
    const commandQueue = new CommandQueue()
    try {
      const core = await h.host.createSession({ cwd: h.dataDir })
      const entry = { key: 'managed-real', ac: new AbortController(), inflight: null, session: core }
      const runner = createFollowUpRunner(
        { commandQueue, activationBarrier: h.host.activationBarrier },
        async () => undefined,
      )
      let resume = false
      const ports = managedInputPorts<ManagedInputEntry>({
        open: async () => entry as unknown as ManagedInputEntry,
        commandQueue,
        // Until `resume`, nothing runs the queued input: a daemon stopped before its turn started.
        continueTurn: (queued) => resume && runner(queued as never),
        preferences: new SessionPreferencesStore(),
      })
      const message = { text: 'Owner said hello.', actor: core.d.actor }
      const withdrawn = await ports.submitInput('managed-real', {
        ...message,
        commandId: 'cmd-w',
        dedupe: false,
      })
      expect(withdrawn.state).toBe('submitted')
      expect(await ports.withdraw('managed-real', 'cmd-w')).toBe('withdrawn')
      expect(await ports.withdraw('managed-real', 'cmd-w')).toBe('absent')

      const first = await ports.submitInput('managed-real', { ...message, commandId: 'cmd-1', dedupe: false })
      if (first.state !== 'submitted') throw new Error('first submission was refused')
      resume = true
      expect(
        await ports.submitInput('managed-real', { ...message, commandId: 'cmd-1', dedupe: true }),
      ).toEqual(first)
      await vi.waitFor(async () =>
        expect(await ports.findUserMessage('managed-real', 'cmd-1', first.seq)).toEqual({
          seq: expect.any(Number),
          turn: 1,
        }),
      )
      await vi.waitFor(async () =>
        expect(await ports.lastTurnEnd('managed-real')).toMatchObject({
          reason: 'completed',
          laterStart: false,
        }),
      )
      expect(
        await ports.submitInput('managed-real', { ...message, commandId: 'cmd-1', dedupe: true }),
      ).toEqual(first)
      const ran = (await core.scan({ type: 'user/message', limit: 50 })).filter(
        (row) => (row.data as { commandId?: string }).commandId === 'cmd-1',
      )
      expect(ran, 'the resubmitted input ran once').toHaveLength(1)
      expect(await ports.withdraw('managed-real', 'cmd-1')).toBe('taken')
    } finally {
      await commandQueue.close()
      await h.close()
    }
  })
})

describe('idle signal', () => {
  it('runs idle listeners on a later tick and keeps a failing listener from the caller', async () => {
    const signal = createIdleSignal()
    const seen: string[] = []
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      signal.onIdle(() => {
        throw new Error('listener broke')
      })
      signal.onIdle(async () => Promise.reject(new Error('async listener broke')))
      const off = signal.onIdle((sessionId) => seen.push(sessionId))
      expect(() => signal.notify('session-1')).not.toThrow()
      expect(seen, 'nothing runs inside the hook').toEqual([])
      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setImmediate(resolve))
      expect(seen).toEqual(['session-1'])
      expect(error).toHaveBeenCalledTimes(2)
      off()
      signal.notify('session-2')
      await new Promise((resolve) => setImmediate(resolve))
      expect(seen).toEqual(['session-1'])
    } finally {
      error.mockRestore()
    }
  })

  it('runs startup listeners once when started, and a late listener once after that', async () => {
    const signal = createIdleSignal()
    const seen: string[] = []
    signal.onStartup(() => seen.push('early'))
    const off = signal.onStartup(() => seen.push('removed'))
    off()
    await new Promise((resolve) => setImmediate(resolve))
    expect(seen, 'nothing before the daemon accepts connections').toEqual([])
    signal.started()
    signal.started()
    expect(seen).toEqual([])
    await new Promise((resolve) => setImmediate(resolve))
    expect(seen).toEqual(['early'])
    signal.onStartup(() => seen.push('late'))
    await new Promise((resolve) => setImmediate(resolve))
    expect(seen).toEqual(['early', 'late'])
  })
})
