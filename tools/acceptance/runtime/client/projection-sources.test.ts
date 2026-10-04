import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createProjectionProvider } from '../../../../packages/core/src/runtime/providers/projection.js'
import { SessionRegistry } from '../../../../packages/daemon/src/local/sessions.js'
import { openDomainStore } from '../../../../packages/daemon/src/runtime/events/outbox.js'
import { nativeConversation } from '../../../../packages/daemon/src/runtime/native-conversation.js'
import { MemorySessionPrincipalOwnership } from '../../../../packages/daemon/src/storage/session-ownership.js'
import { openTestHost, say } from '../../../../packages/daemon/test/host.js'
import {
  callContext,
  createProjectionFixture,
  domainEvent,
  READER,
  WORKSPACE,
} from '../../../../packages/extension-api/testkit/runtime/contracts/projection.js'
import type * as Wire from '../../../../packages/protocol/src/runtime/index.js'
import { canonicalJsonDigest } from '../../../../packages/protocol/src/runtime/index.js'

// The default projection provider of core read over the daemon's two real sources: the native window
// of a session open in the daemon registry, and the committed records of a domain store.
type Context = ReturnType<typeof callContext>
type Outcome<T> = { ok: true; value: T } | { ok: false; error: Wire.RuntimeError }

const AUTHORITY = 'sources-authority'
const BINDING = {
  bindingId: 'sources',
  contract: 'agh.projection',
  logicalName: 'tasks',
  providerId: 'default',
}
const unused = async (): Promise<never> => {
  throw new Error('not used by these reads')
}
const detail = (outcome: Outcome<unknown>) => (outcome.ok ? 'ok' : outcome.error.detailCode)
function must<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw new Error(`${outcome.error.detailCode}: ${outcome.error.message}`)
  return outcome.value
}

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function sources() {
  const h = await openTestHost({ script: [say('one'), say('two'), say('three')] })
  cleanups.push(() => h.close())
  const registry = new SessionRegistry(h.host, { clock: () => Date.now(), pollMs: 5 })
  cleanups.push(() => registry.closeAll())
  const entry = await registry.open({ cwd: h.dataDir })
  const ownership = new MemorySessionPrincipalOwnership()
  ownership.bindNew(entry.key, READER.principalRef)
  ownership.activateNew(entry.key, READER.principalRef)

  // The producer and the projection hold their own connections to one domain store.
  const open = () =>
    openDomainStore({
      file: join(h.dataDir, 'domain.sqlite'),
      owner: {
        authority: { authorityId: AUTHORITY, tenantId: 'sources', authorityEpoch: 1 },
        scope: WORKSPACE,
        ownerBinding: BINDING,
      },
      permits: async () => false,
    })
  const writer = open()
  const reader = open()
  cleanups.push(() => {
    writer.close()
    reader.close()
  })

  const journal = async (after: number, limit: number) => reader.events(after, limit)
  const native = nativeConversation({ registry, sessionOwnership: ownership, workspaces: h.workspaces })
  const fixture = createProjectionFixture()
  const provider = createProjectionProvider({
    binding: BINDING,
    reads: { query: unused, resolveData: unused },
    domain: fixture.domain,
    access: fixture.gate,
    native,
    journal,
    owner: {
      namespace: 'conformance.tasks',
      authorityId: AUTHORITY,
      aggregate: { typeId: 'conformance.tasks/board@1', id: 'board' },
      source: BINDING,
      stateSchema: fixture.domain.commandStateSchema,
      destination: 'runtime-inbox',
      // Commands are not read here; the daemon store's command handle type is not core's port yet.
      storage: { transaction: unused },
      clock: { now: () => new Date().toISOString(), newId: () => crypto.randomUUID() },
    },
  })
  cleanups.push(() => provider.close())

  const sessionId = entry.key
  return {
    sessionId,
    native,
    writer,
    journal,
    provider,
    async turn(text: string) {
      await entry.session.enqueue('next-turn', {
        actor: entry.session.d.actor,
        content: [{ type: 'text', text }],
      })
      await entry.session.run({ until: 'turn-end', signal: AbortSignal.timeout(10_000) })
      return (await entry.session.projectUI()).nodes.map((node) => node.id)
    },
    /** Commits one task card the way a domain command commits its event. */
    commit(taskId: string, fault?: () => void) {
      return writer.transaction((tx) => {
        const sequence = tx.lastSequence() + 1
        const event = domainEvent(`event-${taskId}`, 'added', sessionId, {
          taskId,
          board: 'open',
          title: taskId,
        })
        tx.putEvent({
          event,
          authorityId: AUTHORITY,
          sequence,
          aggregate: {
            authorityId: AUTHORITY,
            typeId: 'conformance.tasks/board@1',
            id: 'board',
            revision: sequence,
          },
          fingerprint: canonicalJsonDigest(event.eventId),
        })
        fault?.()
      })
    },
    /** Every page from the newest back, oldest first, with domain entries named by their view id. */
    async read(limit: number, context = callContext()) {
      const pages = [must(await provider.openConversation({ sessionId, limit }, context))]
      for (let page = pages[0]; page?.nextPageCursor; ) {
        page = must(
          await provider.conversationHistory({ sessionId, cursor: page.nextPageCursor, limit }, context),
        )
        pages.push(page)
      }
      const views = new Map(pages.flatMap((page) => page.domains.map((item) => [item.id, item.view.viewId])))
      return pages.reverse().flatMap((page) => page.order.map((item) => views.get(item.id) ?? item.id))
    },
  }
}

describe('projection read over the daemon sources', () => {
  it("pages a real session's native history and places each committed domain event after it", async () => {
    const s = await sources()
    const first = await s.turn('first')
    await s.commit('card-1')
    expect(await s.provider.refresh()).toBeNull()
    const second = await s.turn('second')
    await s.commit('card-2')
    expect(await s.provider.refresh()).toBeNull()
    const third = await s.turn('third')

    expect(third.length).toBeGreaterThan(second.length)
    expect(await s.read(2)).toEqual([
      ...first,
      'card-1',
      ...second.slice(first.length),
      'card-2',
      ...third.slice(second.length),
    ])

    // A record committed after the provider's cursor is read next, after the earlier ones.
    await s.commit('card-3')
    expect((await s.journal(2, 10)).map((record) => record.sequence)).toEqual([3])
    expect((await s.journal(0, 2)).map((record) => record.sequence)).toEqual([1, 2])
    expect(await s.provider.refresh()).toBeNull()
    const all = await s.read(3)
    expect(all.filter((id) => id.startsWith('card-'))).toEqual(['card-1', 'card-2', 'card-3'])
    expect(all.at(-1)).toBe('card-3')
    // One item a page reads the same conversation, including pages that hold no native node.
    expect(await s.read(1)).toEqual(all)
  })

  it('reads only committed records', async () => {
    const s = await sources()
    await s.turn('first')
    await expect(
      s.commit('rolled-back', () => {
        throw new Error('fault before commit')
      }),
    ).rejects.toThrow('fault before commit')
    let pending: ReturnType<typeof s.journal> | undefined
    await s.commit('card-1', () => {
      // The journal reads on the projection's own connection at once, while this write is still open.
      pending = s.journal(0, 10)
    })
    expect(await pending).toEqual([])
    expect(await s.provider.refresh()).toBeNull()
    const cards = (await s.read(10)).filter((id) => id === 'rolled-back' || id.startsWith('card-'))
    expect(cards).toEqual(['card-1'])
  })

  it('refuses an unknown session, a reader who does not own it and a page past its history', async () => {
    const s = await sources()
    await s.turn('first')
    const open = (sessionId: string, context: Context) =>
      s.provider.openConversation({ sessionId, limit: 5 }, context)
    expect(detail(await open(s.sessionId, callContext()))).toBe('ok')
    expect(detail(await open('agnes:missing', callContext()))).toBe('not_found')
    expect(detail(await open(s.sessionId, callContext('intruder')))).toBe('permission_denied')
    // A page before an index the native history does not reach asks the reader to resynchronize.
    expect(detail(await s.native.page(s.sessionId, 999, 2, callContext()))).toBe('resync_required')
  })
})
