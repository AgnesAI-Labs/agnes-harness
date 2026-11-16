import { ScriptedProvider } from '@agnes/ai/testkit'
import { bundledAppProof } from '@agnes/daemon-foundation/local/bundled-app'
import type { JournalIdentity, JournalResult } from '@agnes/daemon-foundation/local/ports'
import { MemoryJournal } from '@agnes/daemon-foundation/local/ports'
import type { JsonRpcMessage } from '@agnes/daemon-foundation/rpc'
import { MemorySessionPrincipalOwnership } from '@agnes/daemon-foundation/storage/session-ownership'
import { describe, expect, it, vi } from 'vitest'
import type { LocalEndpointOptions } from '../src/local/index.js'
import { BUNDLED_APP_INPUT_SUMMARY, withMachineOrigin } from '../src/local/machine-input.js'
import { openTestHost, say } from './host.js'

const KEY = 'a'.repeat(64)
const APP = 'bundled-app:@agnes/superagent/superagent'
const OWNER = 'owner-cli'
const DISPATCH = JSON.stringify({ ticket_id: 't1', title: 'Fix login', assignment: 'Repair the login form' })
const SOURCE = 'agnes/bundled-app'

type Endpoint = { handle(m: JsonRpcMessage): Promise<JsonRpcMessage | undefined>; close(): Promise<void> }
type InboxItem = { commandId?: string; origin?: string; trust?: string; system?: unknown; content: unknown }
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

/** Every inbox item the session ever held, by command id: what each delivery was admitted as. */
async function admitted(h: Awaited<ReturnType<typeof openTestHost>>, sessionId: string) {
  const session = ledger(h, sessionId)
  const rows = await session.scan({ fromSeq: 1, toSeq: session.lastSeq, type: 'inbox' })
  const items = new Map<string, InboxItem>()
  for (const row of rows)
    for (const item of (row.data as { items: InboxItem[] }).items)
      if (item.commandId && !items.has(item.commandId)) items.set(item.commandId, item)
  return items
}

describe('machine input from the bundled application', () => {
  it('marks a delivery into a session the application created as machine input, with its data kept for the model', async () => {
    const provider = new ScriptedProvider({ scripts: [say('on it')] })
    const h = await openTestHost({ provider })
    const app = await connect(h, APP, true)
    const sessionId = await create(app, h.dataDir, 'superagent:worker:t1')
    expect(await deliver(app, APP, sessionId, 'superagent:m1')).toMatchObject({ result: { replayed: false } })
    const item = (await admitted(h, sessionId)).get('superagent:m1')
    expect(item).toMatchObject({
      origin: 'system',
      trust: 'untrusted',
      system: { source: SOURCE, type: 'delivery', data: JSON.parse(DISPATCH) },
    })
    // The shown text is a fixed summary, never the message body.
    const summary = (item?.system as { summary?: string } | undefined)?.summary ?? ''
    expect(item?.content).toEqual([{ type: 'text', text: summary }])
    expect(summary).not.toContain('Repair the login form')
    // The model still reads the whole delivery, and the trace keeps it with the message.
    await vi.waitFor(() => expect(provider.calls.length).toBeGreaterThan(0))
    expect(JSON.stringify(provider.calls.at(-1)?.messages)).toContain('Repair the login form')
    const session = ledger(h, sessionId)
    const [message] = await session.scan({ fromSeq: 1, toSeq: session.lastSeq, type: 'user/message' })
    expect(message).toMatchObject({
      origin: 'system',
      trust: 'untrusted',
      data: { commandId: 'superagent:m1', system: { source: SOURCE, data: JSON.parse(DISPATCH) } },
    })
    await app.close()
    await h.close()
  })

  // One connection at a time holds a session open here, as the daemon's one registry does for all of them.
  it('keeps the same bytes ordinary from the owner, a client that only names itself the application, or a steer of theirs', async () => {
    const h = await openTestHost()
    const app = await connect(h, APP, true)
    const sessionId = await create(app, h.dataDir, 'superagent:worker:t2')
    expect(
      await deliver(app, APP, sessionId, 'superagent:m2', 'Note from the orchestrator', 'steer'),
    ).toMatchObject({
      result: { replayed: false },
    })
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
      expect(items.get(commandId)?.origin, commandId).toBeUndefined()
      expect(items.get(commandId)?.system, commandId).toBeUndefined()
      expect(items.get(commandId)).toMatchObject({
        trust: 'trusted',
        content: [{ type: 'text', text: DISPATCH }],
      })
    }
    // The application's own steer is machine input; text that is not JSON is kept as the text.
    expect(items.get('superagent:m2')).toMatchObject({
      origin: 'system',
      system: { source: SOURCE, data: 'Note from the orchestrator' },
    })
    await forged.close()
    await h.close()
  })

  it('keeps ordinary what the application delivers into a session it did not create, however it was created', async () => {
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
      expect(item?.origin, sessionId).toBeUndefined()
      expect(item, sessionId).toMatchObject({ trust: 'trusted', content: [{ type: 'text', text: DISPATCH }] })
    }
    await app.close()
    await h.close()
  })

  it('keeps the creator of a creation the application began and finished on a replay', async () => {
    const ownership = new MemorySessionPrincipalOwnership()
    const h = await openTestHost()
    // The application's first reservation, which a stop interrupted before the session opened.
    expect(ownership.bindNew('superagent:worker:t5', 'local', 'bundled-app')).toBe(true)
    // Whoever replays the creation, it stays the application's.
    const owner = await connect(h, OWNER, false, { sessionOwnership: ownership })
    const sessionId = await create(owner, h.dataDir, 'superagent:worker:t5')
    expect(await deliver(owner, OWNER, sessionId, 'earlier')).toMatchObject({ result: { replayed: false } })
    await owner.close()
    const app = await connect(h, APP, true, { sessionOwnership: ownership })
    expect(await create(app, h.dataDir, 'superagent:worker:t5')).toBe(sessionId)
    expect(await deliver(app, APP, sessionId, 'superagent:m5')).toMatchObject({ result: { replayed: false } })
    const items = await admitted(h, sessionId)
    expect(items.get('superagent:m5')).toMatchObject({ origin: 'system', system: { source: SOURCE } })
    // An earlier input of the owner's is left as it was.
    expect(items.get('earlier')?.origin).toBeUndefined()
    expect(items.get('earlier')).toMatchObject({
      trust: 'trusted',
      content: [{ type: 'text', text: DISPATCH }],
    })
    await app.close()
    await h.close()
  })

  it('admits a delivery once across a lost receipt, still as machine input', async () => {
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
    expect((await admitted(h, sessionId)).get('superagent:m6')).toMatchObject({ origin: 'system' })
    await app.close()
    await h.close()
  })
})

describe('withMachineOrigin', () => {
  const message = {
    content: [{ type: 'text' as const, text: DISPATCH }],
    actor: { id: 'local', org: 'local', role: 'owner', deptPath: [], attrs: {} },
  }
  const app = { bundledApp: true as const, principalId: 'local' }
  const marked = () => {
    const ownership = new MemorySessionPrincipalOwnership()
    ownership.bindNew('s', 'local', 'bundled-app')
    ownership.activateNew('s', 'local')
    return ownership
  }

  it('needs the connection, the active owner and the recorded creator together', () => {
    expect(withMachineOrigin(marked(), app, 's', message)).toMatchObject({
      origin: 'system',
      trust: 'untrusted',
      content: [{ type: 'text', text: BUNDLED_APP_INPUT_SUMMARY }],
    })
    const pending = new MemorySessionPrincipalOwnership()
    pending.bindNew('s', 'local', 'bundled-app')
    const unmarked = new MemorySessionPrincipalOwnership()
    unmarked.bindNew('s', 'local')
    unmarked.activateNew('s', 'local')
    const failing = {
      resolve: marked().resolve.bind(marked()),
      creator: () => {
        throw new Error('session principal ownership unavailable')
      },
    }
    for (const [ownership, conn, sessionId] of [
      [marked(), { principalId: 'local' }, 's'],
      [marked(), { bundledApp: true as const, principalId: 'another' }, 's'],
      [marked(), app, 'other'],
      [pending, app, 's'],
      [unmarked, app, 's'],
      [failing, app, 's'],
      [undefined, app, 's'],
    ] as const)
      expect(withMachineOrigin(ownership, conn, sessionId, message)).toBe(message)
  })

  it('leaves input it cannot carry whole ordinary', () => {
    const reference = { source: 'file', id: 'a', label: 'a', hash: 'a'.repeat(64), truncated: false }
    for (const content of [
      [],
      [
        { type: 'text' as const, text: 'a' },
        { type: 'text' as const, text: 'b' },
      ],
      [{ type: 'text' as const, text: DISPATCH, reference }],
      [{ type: 'image' as const, data: 'AAAA', mimeType: 'image/png' }],
    ]) {
      const input = { ...message, content }
      expect(withMachineOrigin(marked(), app, 's', input as never)).toBe(input)
    }
  })
})
