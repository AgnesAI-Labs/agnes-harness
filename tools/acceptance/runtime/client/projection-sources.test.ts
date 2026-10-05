import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  eventFingerprint as commandFingerprint,
  createDomainCommands,
} from '../../../../packages/core/src/runtime/projection/commands.js'
import { createProjectionProvider } from '../../../../packages/core/src/runtime/providers/projection.js'
import { SessionRegistry } from '../../../../packages/daemon/src/local/sessions.js'
import { openDomainStore } from '../../../../packages/daemon/src/runtime/events/outbox.js'
import { nativeConversation } from '../../../../packages/daemon/src/runtime/native-conversation.js'
import {
  createEventsProvider,
  type EventsGate,
  eventFingerprint as publishFingerprint,
} from '../../../../packages/daemon/src/runtime/providers/events.js'
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
      storage: writer,
      clock: { now: () => new Date().toISOString(), newId: () => crypto.randomUUID() },
    },
  })
  cleanups.push(() => provider.close())
  // A writer commit starts the fold before its transaction resolves, so nothing here refreshes by hand.
  cleanups.push(writer.subscribeCommitted(() => provider.refresh()))

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
    const second = await s.turn('second')
    await s.commit('card-2')
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

describe('one event identity across the command path and publication over the daemon domain store', () => {
  const schemaRef = (typeId: string): Wire.SchemaRef => ({
    typeId,
    revision: 1,
    digest: canonicalJsonDigest(typeId),
  })
  const inline = (schema: Wire.SchemaRef, value: Wire.JsonValue): Wire.DataRef => ({
    kind: 'inline',
    schema,
    value,
    digest: canonicalJsonDigest(value),
    bytes: Buffer.byteLength(JSON.stringify(value)),
  })
  const NOTED = schemaRef('conformance.tasks/noted@1')
  const INPUT = schemaRef('conformance.tasks/note-input@1')
  const RESULT = schemaRef('conformance.tasks/note-result@1')
  const STATE = schemaRef('conformance.tasks/state@1')
  const BOARD = { typeId: 'conformance.tasks/board@1', id: 'board' }
  const SESSION: Wire.ScopeRef = { ...WORKSPACE, kind: 'session', sessionId: 'session-1' }
  const call = (principalRef: string, bindingId: string) => ({
    principalRef,
    scope: SESSION,
    bindingId,
    invocationId: `${principalRef}-invocation`,
    deadline: '2100-01-01T00:00:00.000Z',
    traceRef: `${principalRef}-trace`,
    authorizationRef: `${principalRef}-authorization`,
    signal: new AbortController().signal,
  })

  /** A command owner and the default events provider over one domain store; the producer is the owner. */
  function paths() {
    const dir = mkdtempSync(join(tmpdir(), 'event-identity-'))
    const store = openDomainStore({
      file: join(dir, 'domain.sqlite'),
      owner: {
        authority: { authorityId: AUTHORITY, tenantId: 'sources', authorityEpoch: 1 },
        scope: WORKSPACE,
        ownerBinding: BINDING,
      },
      permits: async () => false,
    })
    // The fixture authority vouches every revision and names the command that caused the object.
    const origin = { causation: { commandId: 'id-1' } as Wire.DomainEvent['causation'] }
    const gate: EventsGate = {
      producer: async () => ({ ok: true, value: BINDING }),
      revision: async (aggregate) => aggregate.revision,
      origin: async () => ({ ok: true, value: { scope: SESSION, causation: origin.causation } }),
      withCommit: (_typeId, _schema, aggregate, _causation, _context, body) => ({
        ok: true,
        value: body({
          producer: BINDING,
          scope: SESSION,
          causation: origin.causation,
          revision: aggregate.revision,
        }),
      }),
      canRead: async () => true,
    }
    const events = createEventsProvider({ binding: BINDING, store, cursorKey: randomBytes(32), gate })
    const action: Wire.ViewAction = {
      actionKey: 'note',
      label: 'Note',
      requiredFeatures: [],
      availability: 'enabled',
      disabledReason: null,
      kind: 'command',
      command: 'note',
      inputSchema: INPUT,
    }
    let ids = 0
    const commands = createDomainCommands({
      namespace: 'conformance.tasks',
      authorityId: AUTHORITY,
      aggregate: BOARD,
      source: BINDING,
      stateSchema: STATE,
      destination: 'runtime-inbox',
      storage: store,
      views: {
        // Only the view identity is read; the rest of the view does not take part in these commits.
        resolve: async () => ({
          ok: true,
          value: { view: { viewId: 'board', revision: 1 } as Wire.DomainView, action },
        }),
        canRead: async () => true,
      },
      commands: new Map([
        [
          'note',
          {
            inputSchema: INPUT,
            resultSchema: RESULT,
            completion: 'domain-commit' as const,
            async prepare(frame: Wire.DomainCommandFrame) {
              const input = frame.input as Extract<Wire.DataRef, { kind: 'inline' }>
              const { key, note } = input.value as { key: string; note: string }
              return {
                ok: true as const,
                value: {
                  expectedRevision: frame.stateRevision,
                  state: inline(STATE, { revision: frame.stateRevision + 1 }),
                  events: [
                    {
                      typeId: NOTED.typeId,
                      schema: NOTED,
                      payload: inline(NOTED, { note }),
                      idempotencyKey: key,
                    },
                  ],
                  dispatches: [],
                  result: inline(RESULT, { ok: true }),
                },
              }
            },
          },
        ],
      ]),
      clock: { now: () => '2026-10-05T00:00:00Z', newId: () => `id-${++ids}` },
    })
    cleanups.push(() => {
      events.close()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    })
    const command = (requestId: string, key: string, note: string, expectedRevision: number) =>
      commands.submit({
        request: {
          negotiatedSession: 'negotiated-1',
          clientInstanceId: 'client-1',
          catalogRevision: 1,
          ownerToken: 'owner-token',
          action: { viewId: 'board', actionKey: 'note', viewRevision: 1 },
          input: inline(INPUT, { key, note }),
          requestId,
          expectedRevision,
          commandSchema: INPUT,
        },
        context: call('alice', 'client-binding'),
        features: [],
      })
    const publish = (key: string, note: string, revision: number) =>
      events.publish(
        {
          domainSchema: NOTED,
          payload: inline(NOTED, { note }),
          causationRef: {
            kind: 'run',
            value: {
              runId: 'run-1',
              session: {
                sessionId: 'session-1',
                authority: { authorityId: 'state-authority', tenantId: 'sources', authorityEpoch: 1 },
              },
            },
          },
          typeId: NOTED.typeId,
          idempotencyKey: key,
          aggregate: { authorityId: AUTHORITY, ...BOARD, revision },
        },
        call('producer', BINDING.bindingId),
      )
    const read = () =>
      events.subscribe(
        { scopeRef: SESSION, types: [NOTED.typeId], cursor: null, limit: 10 },
        call('reader', 'reader'),
      )
    return { store, origin, command, publish, read, status: commands.commandStatus }
  }

  it('replays an event a command committed to a publication of the same content and refuses another', async () => {
    const p = paths()
    expect(detail(await p.command('request-1', 'k-1', 'one', 0))).toBe('ok')
    const [record] = p.store.events(0, 10)
    if (record === undefined) throw new Error('the command committed no event')
    // Each path computes the stored fingerprint from the record's own content.
    expect(commandFingerprint(record.aggregate, record.event)).toBe(record.fingerprint)
    expect(publishFingerprint(record.aggregate, record.event)).toBe(record.fingerprint)
    expect(await p.publish('k-1', 'one', 1)).toEqual({
      ok: true,
      value: { eventRef: { kind: 'event', authorityId: AUTHORITY, eventId: record.event.eventId } },
    })
    expect(detail(await p.publish('k-1', 'other', 1))).toBe('idempotency_conflict')
    expect(p.store.eventHistory()).toEqual({ count: 1, first: 1, last: 1, highwater: 1 })
  })

  it('skips a planned event a publication committed with the same content and refuses a command on another', async () => {
    const p = paths()
    const published = must(await p.publish('k-1', 'one', 1))
    expect(detail(await p.command('request-1', 'k-1', 'one', 0))).toBe('ok')
    expect(detail(await p.command('request-2', 'k-2', 'two', 1))).toBe('ok')
    // The command wrote no second row for k-1 and its next event took the next sequence.
    const records = p.store.events(0, 10)
    expect(records.map((record) => [record.event.idempotencyKey, record.sequence])).toEqual([
      ['k-1', 1],
      ['k-2', 2],
    ])
    expect(published.eventRef).toEqual({
      kind: 'event',
      authorityId: AUTHORITY,
      eventId: records[0]?.event.eventId,
    })
    expect(detail(await p.read())).toBe('ok')

    p.origin.causation = { commandId: 'id-7' }
    expect(detail(await p.publish('k-3', 'published', 3))).toBe('ok')
    expect(detail(await p.command('request-3', 'k-3', 'commanded', 2))).toBe('idempotency_conflict')
    expect(must(await p.status('request-3', call('alice', 'client-binding'))).status).toBe('not-accepted')
    expect(p.store.eventHistory()).toEqual({ count: 3, first: 1, last: 3, highwater: 3 })
    expect((await p.store.transaction((tx) => tx.state())).revision).toBe(2)
  })
})
