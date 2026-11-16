import { ScriptedProvider } from '@agnes/ai/testkit'
import { bundledAppProof } from '@agnes/daemon-foundation/local/bundled-app'
import type { JournalIdentity, JournalResult } from '@agnes/daemon-foundation/local/ports'
import { MemoryJournal } from '@agnes/daemon-foundation/local/ports'
import type { JsonRpcMessage } from '@agnes/daemon-foundation/rpc'
import { MemorySessionPrincipalOwnership } from '@agnes/daemon-foundation/storage/session-ownership'
import { describe, expect, it, vi } from 'vitest'
import { withDeliveredBy } from '../src/local/delivered-by.js'
import type { LocalEndpointOptions } from '../src/local/index.js'
import { openTestHost, say, slowProvider } from './host.js'

const KEY = 'a'.repeat(64)
const APP = 'bundled-app:@agnes/superagent/superagent'
const OWNER = 'owner-cli'
const DISPATCH = JSON.stringify({ ticket_id: 't1', title: 'Fix login', assignment: 'Repair the login form' })
const BY = { kind: 'bundled-app', appId: '@agnes/superagent/superagent' }

type Endpoint = { handle(m: JsonRpcMessage): Promise<JsonRpcMessage | undefined>; close(): Promise<void> }
type InboxItem = {
  itemId: string
  commandId?: string
  origin?: string
  trust?: string
  system?: unknown
  content: unknown
  /** The marker the session's own rows give the item (not a field of the item). */
  marker?: unknown
}
let ids = 100

/** A connection to the host; `proof` makes it the bundled application's, as the daemon's shared worker presents it. */
async function connect(
  h: Awaited<ReturnType<typeof openTestHost>>,
  clientId: string,
  proof: boolean,
  options: LocalEndpointOptions = {},
): Promise<Endpoint> {
  const ep = h.endpoint({
    ...options,
    clock: () => Date.now(),
    pollMs: 5,
    auth: {
      config: { transport: 'unix', bundledAppKey: KEY },
      nonces: { consume: () => true },
      clock: () => Date.now(),
    },
  })
  const response = (await ep.handle({
    jsonrpc: '2.0',
    id: ids++,
    method: 'initialize',
    params: {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      _meta: {
        'ai.agnes.harness': {
          clientId,
          auth: { kind: 'local', ...(proof ? { bundledApp: bundledAppProof(KEY, clientId) } : {}) },
        },
      },
    },
  })) as { error?: unknown }
  expect(response.error).toBeUndefined()
  return ep
}

async function create(ep: Endpoint, cwd: string, sessionKey: string): Promise<string> {
  const response = (await ep.handle({
    jsonrpc: '2.0',
    id: ids++,
    method: 'session/new',
    params: { cwd, mcpServers: [], _meta: { 'ai.agnes.harness': { sessionKey } } },
  })) as { result?: { sessionId: string }; error?: unknown }
  expect(response.error).toBeUndefined()
  if (!response.result) throw new Error('session/new returned no session')
  return response.result.sessionId
}

async function load(ep: Endpoint, sessionId: string, cwd: string): Promise<void> {
  const response = (await ep.handle({
    jsonrpc: '2.0',
    id: ids++,
    method: 'session/load',
    params: { sessionId, cwd, mcpServers: [] },
  })) as { error?: unknown }
  expect(response.error).toBeUndefined()
}

async function deliver(
  ep: Endpoint,
  clientId: string,
  sessionId: string,
  commandId: string,
  text = DISPATCH,
  kind: 'followUp' | 'steer' = 'followUp',
): Promise<JsonRpcMessage | undefined> {
  return ep.handle({
    jsonrpc: '2.0',
    id: ids++,
    method: '_agnes/v1/submit',
    params: {
      clientId,
      kind,
      commandId,
      payload: { sessionId, content: [{ type: 'text', text }] },
    },
  })
}

function ledger(h: Awaited<ReturnType<typeof openTestHost>>, sessionId: string) {
  const session = h.host.kernel.get(sessionId)
  if (!session) throw new Error(`no open session ${sessionId}`)
  return session
}

/**
 * Every inbox item the session ever held, by command id: what each delivery was admitted as, with the marker its
 * session's own inbox-delivered-by rows give it. No row an earlier release validates (an inbox item, a user message)
 * may carry the marker itself.
 */
async function admitted(h: Awaited<ReturnType<typeof openTestHost>>, sessionId: string) {
  const session = ledger(h, sessionId)
  const rows = await session.scan({ fromSeq: 1, toSeq: session.lastSeq, type: ['inbox', 'user/message'] })
  const markers = await session.scan({
    fromSeq: 1,
    toSeq: session.lastSeq,
    type: 'x/core/inbox-delivered-by',
  })
  const items = new Map<string, InboxItem>()
  for (const row of rows) {
    if (row.type === 'user/message') {
      expect(row.data).not.toHaveProperty('deliveredBy')
      continue
    }
    for (const item of (row.data as { items: InboxItem[] }).items) {
      expect(item).not.toHaveProperty('deliveredBy')
      if (!item.commandId || items.has(item.commandId)) continue
      const marker = markers
        .filter(
          (marker) =>
            marker.origin === 'system' && (marker.data as { itemId?: string }).itemId === item.itemId,
        )
        .at(-1)
      const deliveredBy = (marker?.data as { deliveredBy?: unknown } | undefined)?.deliveredBy
      items.set(item.commandId, { ...item, ...(deliveredBy ? { marker: deliveredBy } : {}) })
    }
  }
  return items
}

/** An item as admitted, but for the fields that differ between any two deliveries: its ids and when it came. */
const admittedAs = (item: InboxItem | undefined) => {
  const {
    itemId: _itemId,
    commandId: _commandId,
    admissionId: _admissionId,
    enqueuedAt: _at,
    ...rest
  } = (item ?? {}) as InboxItem & Record<string, unknown>
  return rest
}
/** The message of a model request that carries the dispatch. */
const dispatchMessage = (provider: ScriptedProvider, call: number) =>
  provider.calls[call]?.messages.find((message) => JSON.stringify(message).includes('Repair the login form'))

describe('what the bundled application delivers', () => {
  it('is marked as its delivery in a session it created, and is otherwise the input it was', async () => {
    const provider = new ScriptedProvider({ scripts: [say('on it')] })
    const h = await openTestHost({ provider })
    const app = await connect(h, APP, true)
    const marked = await create(app, h.dataDir, 'superagent:worker:t1')
    expect(await deliver(app, APP, marked, 'superagent:m1')).toMatchObject({ result: { replayed: false } })
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1))
    const item = (await admitted(h, marked)).get('superagent:m1')
    // The message in the history is the owner's input as before; Core's own row names it as the app's for the reader.
    const session = ledger(h, marked)
    await vi.waitFor(async () =>
      expect(await session.scan({ fromSeq: 1, toSeq: session.lastSeq, type: 'user/message' })).toHaveLength(
        1,
      ),
    )
    const [message] = await session.scan({ fromSeq: 1, toSeq: session.lastSeq, type: 'user/message' })
    expect(message).toMatchObject({
      origin: 'principal',
      trust: 'trusted',
      data: { commandId: 'superagent:m1', content: [{ type: 'text', text: DISPATCH }] },
    })
    const [named] = await session.scan({
      fromSeq: 1,
      toSeq: session.lastSeq,
      type: 'x/core/input-delivered-by',
    })
    expect(named).toMatchObject({
      origin: 'system',
      trust: 'trusted',
      data: { messageIds: [message?.id], deliveredBy: BY },
    })
    expect(
      (await session.projectUI()).nodes.find(
        (node) => node.kind === 'user' && node.commandId === 'superagent:m1',
      ),
    ).toMatchObject({ origin: 'principal', deliveredBy: BY })
    await app.close()
    // The very same delivery from the owner's own client, into a session of the owner's.
    const owner = await connect(h, OWNER, false)
    const plain = await create(owner, h.dataDir, 'owner:plain')
    expect(await deliver(owner, OWNER, plain, 'superagent:m1')).toMatchObject({ result: { replayed: false } })
    await vi.waitFor(() => expect(provider.calls).toHaveLength(2))
    const unmarked = (await admitted(h, plain)).get('superagent:m1')
    expect(item).toMatchObject({
      marker: BY,
      trust: 'trusted',
      content: [{ type: 'text', text: DISPATCH }],
    })
    expect(item?.origin).toBeUndefined()
    expect(item?.system).toBeUndefined()
    // Only the marker tells them apart: trust, kind, content and actor are those of the owner's own input.
    const { marker: _marker, ...rest } = admittedAs(item)
    expect(rest).toEqual(admittedAs(unmarked))
    // The model reads the same message either way.
    expect(dispatchMessage(provider, 0)).toBeDefined()
    expect(dispatchMessage(provider, 0)).toEqual(dispatchMessage(provider, 1))
    await owner.close()
    await h.close()
  })

  it('waits in the queue as before, listed among the pending inputs like the same input of the owner', async () => {
    const h = await openTestHost({ provider: slowProvider(30_000) })
    const app = await connect(h, APP, true)
    const sessionId = await create(app, h.dataDir, 'superagent:worker:t7')
    // The first delivery runs a turn the slow model holds open; the next ones wait for it.
    expect(await deliver(app, APP, sessionId, 'superagent:first')).toMatchObject({
      result: { replayed: false },
    })
    await vi.waitFor(async () => expect((await ledger(h, sessionId).projectUI()).opState).not.toBeNull())
    expect(await deliver(app, APP, sessionId, 'superagent:queued')).toMatchObject({
      result: { replayed: false },
    })
    const pending = (await ledger(h, sessionId).projectUI()).pendingInputs ?? []
    expect(pending).toEqual([
      { itemId: expect.any(String), preview: DISPATCH, commandId: 'superagent:queued' },
    ])
    expect((await admitted(h, sessionId)).get('superagent:queued')).toMatchObject({ marker: BY })
    await app.close()
    await h.close()
  })

  // One connection at a time holds a session open here, as the daemon's one registry does for all of them.
  it('is not marked from the owner, a client that only names itself the application, or in a steer of theirs', async () => {
    const h = await openTestHost()
    const app = await connect(h, APP, true)
    const sessionId = await create(app, h.dataDir, 'superagent:worker:t2')
    expect(
      await deliver(app, APP, sessionId, 'superagent:m2', 'Note from the orchestrator', 'steer'),
    ).toMatchObject({ result: { replayed: false } })
    await app.close()
    const owner = await connect(h, OWNER, false)
    await load(owner, sessionId, h.dataDir)
    expect(await deliver(owner, OWNER, sessionId, 'pasted')).toMatchObject({ result: { replayed: false } })
    expect(await deliver(owner, OWNER, sessionId, 'pasted-steer', DISPATCH, 'steer')).toMatchObject({
      result: { replayed: false },
    })
    await owner.close()
    const forged = await connect(h, APP, false)
    await load(forged, sessionId, h.dataDir)
    expect(await deliver(forged, APP, sessionId, 'superagent:forged')).toMatchObject({
      result: { replayed: false },
    })
    const items = await admitted(h, sessionId)
    for (const commandId of ['pasted', 'superagent:forged', 'pasted-steer']) {
      expect(items.get(commandId)?.marker, commandId).toBeUndefined()
      expect(items.get(commandId)).toMatchObject({
        trust: 'trusted',
        content: [{ type: 'text', text: DISPATCH }],
      })
    }
    // The application's own steer is marked, whatever its text.
    expect(items.get('superagent:m2')).toMatchObject({
      marker: BY,
      trust: 'trusted',
      content: [{ type: 'text', text: 'Note from the orchestrator' }],
    })
    await forged.close()
    await h.close()
  })

  it('is not marked in a session the application did not create, however it was created', async () => {
    const ownership = new MemorySessionPrincipalOwnership()
    const h = await openTestHost()
    // The owner's own session, and one under the application's key that the owner created first.
    const owner = await connect(h, OWNER, false, { sessionOwnership: ownership })
    const own = await create(owner, h.dataDir, 'owner:notes')
    const taken = await create(owner, h.dataDir, 'superagent:worker:t3')
    await owner.close()
    // A reservation left pending by a creation that never finished, from before creators were kept.
    expect(ownership.bindNew('superagent:worker:t4', 'local')).toBe(true)
    const app = await connect(h, APP, true, { sessionOwnership: ownership })
    // The application's replay of each creation succeeds, and records nothing it did not begin with.
    expect(await create(app, h.dataDir, 'superagent:worker:t3')).toBe(taken)
    const unmarked = await create(app, h.dataDir, 'superagent:worker:t4')
    await load(app, own, h.dataDir)
    for (const [index, sessionId] of [own, taken, unmarked].entries()) {
      expect(ownership.creator(sessionId)).toBeUndefined()
      expect(await deliver(app, APP, sessionId, `superagent:x${index}`)).toMatchObject({
        result: { replayed: false },
      })
      const item = (await admitted(h, sessionId)).get(`superagent:x${index}`)
      expect(item?.marker, sessionId).toBeUndefined()
      expect(item, sessionId).toMatchObject({ trust: 'trusted', content: [{ type: 'text', text: DISPATCH }] })
    }
    await app.close()
    await h.close()
  })

  it('is marked in a session whose creation the application began, whoever finished it', async () => {
    const ownership = new MemorySessionPrincipalOwnership()
    const h = await openTestHost()
    // The application's first reservation, which a stop interrupted before the session opened.
    expect(ownership.bindNew('superagent:worker:t5', 'local', 'bundled-app')).toBe(true)
    const owner = await connect(h, OWNER, false, { sessionOwnership: ownership })
    const sessionId = await create(owner, h.dataDir, 'superagent:worker:t5')
    expect(await deliver(owner, OWNER, sessionId, 'earlier')).toMatchObject({ result: { replayed: false } })
    await owner.close()
    const app = await connect(h, APP, true, { sessionOwnership: ownership })
    expect(await create(app, h.dataDir, 'superagent:worker:t5')).toBe(sessionId)
    expect(await deliver(app, APP, sessionId, 'superagent:m5')).toMatchObject({ result: { replayed: false } })
    const items = await admitted(h, sessionId)
    expect(items.get('superagent:m5')).toMatchObject({ marker: BY })
    // An earlier input of the owner's is left as it was.
    expect(items.get('earlier')?.marker).toBeUndefined()
    await app.close()
    await h.close()
  })

  it('is admitted once across a lost receipt, still marked', async () => {
    class CrashAfterDispatchJournal extends MemoryJournal {
      private crash = true
      override async complete(identity: JournalIdentity, result: JournalResult): Promise<void> {
        if (this.crash) {
          this.crash = false
          throw new Error('simulated crash after durable dispatch')
        }
        await super.complete(identity, result)
      }
    }
    const h = await openTestHost()
    const app = await connect(h, APP, true, { journal: new CrashAfterDispatchJournal() })
    const sessionId = await create(app, h.dataDir, 'superagent:worker:t6')
    expect(await deliver(app, APP, sessionId, 'superagent:m6')).toMatchObject({ error: { code: -32603 } })
    // Delivered again under the same command id, as the application does after a restart.
    expect(await deliver(app, APP, sessionId, 'superagent:m6')).toMatchObject({
      result: { seq: expect.any(Number), replayed: true },
    })
    const session = ledger(h, sessionId)
    const rows = await session.scan({ fromSeq: 1, toSeq: session.lastSeq, type: 'inbox' })
    const held = rows.flatMap((row) => (row.data as { items: InboxItem[] }).items)
    expect(
      new Set(held.filter((item) => item.commandId === 'superagent:m6').map((item) => JSON.stringify(item)))
        .size,
    ).toBe(1)
    expect((await admitted(h, sessionId)).get('superagent:m6')).toMatchObject({ marker: BY })
    await app.close()
    await h.close()
  })
})

describe('withDeliveredBy', () => {
  const message = {
    content: [{ type: 'text' as const, text: DISPATCH }],
    actor: { id: 'local', org: 'local', role: 'owner', deptPath: [], attrs: {} },
  }
  const app = { bundledApp: true as const, principalId: 'local', clientId: APP }
  const marked = () => {
    const ownership = new MemorySessionPrincipalOwnership()
    ownership.bindNew('s', 'local', 'bundled-app')
    ownership.activateNew('s', 'local')
    return ownership
  }

  it('needs the connection, the active owner and the recorded creator together', () => {
    expect(withDeliveredBy(marked(), app, 's', message)).toEqual({ ...message, deliveredBy: BY })
    const pending = new MemorySessionPrincipalOwnership()
    pending.bindNew('s', 'local', 'bundled-app')
    const unmarked = new MemorySessionPrincipalOwnership()
    unmarked.bindNew('s', 'local')
    unmarked.activateNew('s', 'local')
    const failing = {
      resolve: (id: string) => marked().resolve(id),
      creator: () => {
        throw new Error('session principal ownership unavailable')
      },
    }
    for (const [ownership, conn, sessionId] of [
      [marked(), { principalId: 'local', clientId: APP }, 's'],
      [marked(), { ...app, principalId: 'another' }, 's'],
      [marked(), { ...app, clientId: 'owner-cli' }, 's'],
      [marked(), { ...app, clientId: 'bundled-app:' }, 's'],
      [marked(), app, 'other'],
      [pending, app, 's'],
      [unmarked, app, 's'],
      [failing, app, 's'],
      [undefined, app, 's'],
    ] as const)
      expect(withDeliveredBy(ownership, conn, sessionId, message)).toBe(message)
  })
})
