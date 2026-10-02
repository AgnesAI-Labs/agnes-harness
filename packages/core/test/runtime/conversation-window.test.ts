import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { fail } from '../../src/runtime/projection/commands.js'
import {
  createProjectionProvider,
  type NativeConversation,
  type ProjectionAccess,
  type ProjectionDomain,
} from '../../src/runtime/providers/projection.js'

/** The shared fixture domain lives in the testkit suite, outside this package's build. */
type Suite = {
  createProjectionFixture(): {
    domain: ProjectionDomain & { commandStateSchema: Wire.SchemaRef }
    gate: ProjectionAccess & { closeBoard(board: string): void }
    native: NativeConversation & {
      say(sessionId: string, count: number): void
      regenerate(sessionId: string): void
      ids(sessionId: string): string[]
    }
    turnOf(event: Wire.DomainEvent): string | null
  }
  domainEvent(
    eventId: string,
    type: string,
    sessionId: string,
    payload: Record<string, string>,
    runId?: string,
  ): Wire.DomainEvent
  callContext(principalRef?: string): CallContext
  sessionScope(sessionId: string): Wire.ScopeRef
}
const loadSuite = async () =>
  (await import(
    new URL('../../../extension-api/testkit/runtime/contracts/projection.ts', import.meta.url).href
  )) as Suite

const NO_READS = {
  query: async () => fail('unsupported', 'no selector reads in this test'),
  resolveData: async () => fail('unsupported', 'no selector reads in this test'),
}
const BINDING = {
  bindingId: 'window',
  contract: 'agh.projection',
  logicalName: 'tasks',
  providerId: 'default',
}

function must<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw new Error(`${outcome.error.detailCode}: ${outcome.error.message}`)
  return outcome.value
}
const detail = (outcome: Outcome<unknown>) => (outcome.ok ? 'ok' : outcome.error.detailCode)

async function windows() {
  const suite = await loadSuite()
  const fixture = suite.createProjectionFixture()
  const records: Wire.DomainEventRecord[] = []
  const start = () =>
    createProjectionProvider({
      binding: BINDING,
      reads: NO_READS,
      domain: fixture.domain,
      access: fixture.gate,
      native: fixture.native,
      turnOf: fixture.turnOf,
      journal: async (after, limit) => records.filter((record) => record.sequence > after).slice(0, limit),
      owner: {
        namespace: 'conformance.tasks',
        authorityId: 'window-authority',
        aggregate: { typeId: 'conformance.tasks/board@1', id: 'board' },
        source: BINDING,
        stateSchema: fixture.domain.commandStateSchema,
        destination: 'runtime-inbox',
        storage: {
          transaction: async () => {
            throw new Error('commands are not used here')
          },
        },
        clock: { now: () => '2026-10-01T00:00:00Z', newId: () => 'unused' },
      },
    })
  let provider = start()
  let n = 0
  const event = async (sessionId: string, type: string, taskId: string, runId?: string) => {
    const payload = {
      taskId,
      board: 'open',
      title: taskId,
      ...(type === 'settled' ? { phase: 'finalized' } : {}),
    }
    const sequence = records.length + 1
    records.push({
      event: suite.domainEvent(`event-${++n}`, type, sessionId, payload, runId),
      authorityId: 'window-authority',
      sequence,
      aggregate: {
        authorityId: 'window-authority',
        typeId: 'conformance.tasks/board@1',
        id: 'board',
        revision: sequence,
      },
      fingerprint: canonicalJsonDigest(sequence),
    })
    expect(await provider.refresh()).toBeNull()
  }
  const context = suite.callContext()
  return {
    suite,
    fixture,
    event,
    add: (sessionId: string, taskId: string, runId?: string) => event(sessionId, 'added', taskId, runId),
    open: async (sessionId: string, limit: number) =>
      must(await provider.openConversation({ sessionId, limit }, context)),
    history: (sessionId: string, cursor: string | null, limit: number, call = context) =>
      provider.conversationHistory({ sessionId, cursor: cursor ?? '', limit }, call),
    openRaw: (request: unknown, call = context) => provider.openConversation(request, call),
    restart() {
      provider.close()
      provider = start()
    },
  }
}

const entryId = (suite: Suite, sessionId: string, viewId: string) =>
  `domain:${canonicalJsonDigest({ domainType: 'conformance.tasks/task@1', scope: suite.sessionScope(sessionId), viewId })}`

/** Every page from the newest back, joined oldest first. */
async function everything(h: Awaited<ReturnType<typeof windows>>, sessionId: string, limit: number) {
  const pages = [await h.open(sessionId, limit)]
  for (let page = pages[0]; page?.nextPageCursor; ) {
    page = must(await h.history(sessionId, page.nextPageCursor, limit))
    pages.push(page)
  }
  return { pages, order: [...pages].reverse().flatMap((page) => page.order.map((item) => item.id)) }
}

describe('runtime conversation window', () => {
  it('keeps two cards with one view id in different sessions apart', async () => {
    const h = await windows()
    await h.add('s1', 'shared')
    await h.add('s2', 'shared')
    const [one, two] = [await h.open('s1', 10), await h.open('s2', 10)]
    expect(one.domains.map((entry) => entry.id)).toEqual([entryId(h.suite, 's1', 'shared')])
    expect(two.domains.map((entry) => entry.id)).toEqual([entryId(h.suite, 's2', 'shared')])
    expect(one.domains[0]?.view.scope).toEqual(h.suite.sessionScope('s1'))
    expect(two.domains[0]?.view.scope).toEqual(h.suite.sessionScope('s2'))
  })

  it('answers one cut for snapshot, order and cursors, and history never moves the live cursor', async () => {
    const h = await windows()
    h.fixture.native.say('cut', 3)
    await h.add('cut', 't1')
    h.fixture.native.say('cut', 2)
    await h.add('cut', 't2')
    const first = await h.open('cut', 10)
    const again = await h.open('cut', 10)
    expect([again.epoch, again.revision, again.orderCursor]).toEqual([
      first.epoch,
      first.revision,
      first.orderCursor,
    ])
    const [n1, n2, n3, n4, n5] = h.fixture.native.ids('cut')
    expect(first.order.map((item) => item.id)).toEqual([
      n1,
      n2,
      n3,
      entryId(h.suite, 'cut', 't1'),
      n4,
      n5,
      entryId(h.suite, 'cut', 't2'),
    ])
    await h.event('cut', 'progressed', 't1')
    const moved = await h.open('cut', 10)
    expect(moved.epoch).toBe(first.epoch)
    expect(moved.revision).toBe(first.revision + 1)
    expect(moved.orderCursor).not.toBe(first.orderCursor)
    expect(moved.domains.find((entry) => entry.view.viewId === 't1')?.view.revision).toBe(2)
    h.fixture.native.say('cut', 1)
    const longer = await h.open('cut', 2)
    expect(longer.revision).toBe(moved.revision + 1)
    const older = must(await h.history('cut', longer.nextPageCursor, 2))
    expect([older.epoch, older.revision, older.orderCursor]).toEqual([
      longer.epoch,
      longer.revision,
      longer.orderCursor,
    ])
  })

  it('starts a new epoch on removal, narrowed access and native regeneration; old pages never revive', async () => {
    const h = await windows()
    for (const task of ['a', 'b', 'c']) await h.add('drop', task)
    const opened = await h.open('drop', 1)
    await h.event('drop', 'removed', 'b')
    const removed = await h.open('drop', 1)
    expect(removed.epoch).not.toBe(opened.epoch)
    expect(detail(await h.history('drop', opened.nextPageCursor, 1))).toBe('resync_required')
    const all = await everything(h, 'drop', 1)
    expect(all.order).toEqual([entryId(h.suite, 'drop', 'a'), entryId(h.suite, 'drop', 'c')])
    h.fixture.gate.closeBoard('elsewhere')
    expect(detail(await h.history('drop', removed.nextPageCursor, 1))).toBe('resync_required')
    const narrowed = await h.open('drop', 1)
    expect(narrowed.epoch).not.toBe(removed.epoch)
    h.fixture.native.regenerate('drop')
    expect(detail(await h.history('drop', narrowed.nextPageCursor, 1))).toBe('resync_required')
    const regenerated = await h.open('drop', 1)
    expect(regenerated.epoch).not.toBe(narrowed.epoch)
    expect(regenerated.native.timeline.generation).toBe(2)
  })

  it('fixes the turn and the order position when an event is first accepted', async () => {
    const h = await windows()
    h.fixture.native.say('fixed', 2)
    await h.add('fixed', 'tied', 'run-1')
    await h.event('fixed', 'noise', 'tied')
    await h.add('fixed', 'free')
    h.fixture.native.say('fixed', 5)
    await h.event('fixed', 'settled', 'tied')
    const window = await h.open('fixed', 20)
    expect(window.domains.map((entry) => [entry.view.viewId, entry.turnId])).toEqual([
      ['tied', 'fixed-turn-1'],
      ['free', null],
    ])
    const ids = window.order.map((item) => item.id)
    expect(ids.indexOf(entryId(h.suite, 'fixed', 'tied'))).toBe(2)
    expect(ids.indexOf(entryId(h.suite, 'fixed', 'free'))).toBe(3)
    // The revision counts projection cuts the window served, not ledger sequences or source sequences.
    expect(window.revision).toBe(1)
  })

  it('resets on rebuild: a new epoch and refused cursors, with the same entry ids', async () => {
    const h = await windows()
    for (const task of ['r1', 'r2']) await h.add('rebuild', task)
    const before = await h.open('rebuild', 1)
    h.restart()
    const after = await h.open('rebuild', 1)
    expect(after.epoch).not.toBe(before.epoch)
    expect(detail(await h.history('rebuild', before.nextPageCursor, 1))).toBe('resync_required')
    expect((await everything(h, 'rebuild', 1)).order).toEqual([
      entryId(h.suite, 'rebuild', 'r1'),
      entryId(h.suite, 'rebuild', 'r2'),
    ])
  })

  it('bounds every page by its limit and pages a long history in fixed order without repeats', async () => {
    const h = await windows()
    for (let index = 0; index < 30; index++) {
      h.fixture.native.say('long', 1)
      await h.add('long', `t${index}`)
    }
    const { pages, order } = await everything(h, 'long', 7)
    expect(pages.every((page) => page.order.length <= 7 && page.domains.length <= 7)).toBe(true)
    expect(order).toHaveLength(60)
    expect(new Set(order).size).toBe(60)
    const expected = h.fixture.native
      .ids('long')
      .flatMap((id, index) => [id, entryId(h.suite, 'long', `t${index}`)])
    expect(order).toEqual(expected)
    for (const limit of [0, 501, 1.5])
      expect(detail(await h.openRaw({ sessionId: 'long', limit }))).toBe('invalid_request')
  })

  it('refuses a session outside the caller scope and a page cursor of another session', async () => {
    const h = await windows()
    await h.add('mine', 'a')
    await h.add('mine', 'b')
    const elsewhere = { ...h.suite.callContext(), scope: h.suite.sessionScope('theirs') }
    expect(detail(await h.openRaw({ sessionId: 'mine', limit: 5 }, elsewhere))).toBe('permission_denied')
    const page = await h.open('mine', 1)
    expect(detail(await h.history('theirs', page.nextPageCursor, 1))).toBe('invalid_request')
    expect(detail(await h.history('mine', page.orderCursor, 1))).toBe('invalid_request')
  })
})
