import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalEndpoint } from '../src/local/endpoint.js'
import { ledgerIntegrityRpcError } from '../src/local/methods/acp.js'
import { MemoryTickets } from '../src/storage/lister.js'
import { openTestHost } from './host.js'

const initialize = {
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  },
}

type TestHost = Awaited<ReturnType<typeof openTestHost>>
type Endpoint = ReturnType<TestHost['endpoint']>
type Response<T = unknown> = {
  result?: T
  error?: { message?: string; data?: { code?: string; reason?: string } }
}
let nextId = 2
const rpc = async <T>(ep: Endpoint, method: string, params: unknown): Promise<Response<T>> =>
  (await ep.handle({ jsonrpc: '2.0', id: nextId++, method, params })) as Response<T>

const refused = {
  message: 'SEMANTIC_REJECTED',
  data: { code: 'E_LEDGER_INTEGRITY', reason: 'ledger-integrity' },
}

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

type Integrity = { scanIntegrity(key: string, q: { fromSeq: number }): Promise<unknown> }

/** A session with a few user rows, closed cleanly (so it has a checkpoint); row 1 is then changed. */
async function tamperedWithCheckpoint(h: TestHost) {
  const first = h.endpoint({ pollMs: 5 })
  await first.handle(initialize)
  const created = await rpc<{ sessionId: string }>(first, 'session/new', { cwd: h.dataDir, mcpServers: [] })
  const sessionId = created.result?.sessionId
  if (!sessionId) throw new Error(JSON.stringify(created))
  const session = h.host.kernel.get(sessionId)
  if (!session) throw new Error('session missing')
  for (const text of ['one', 'two', 'three'])
    await session.append([session.ev('user/message', { content: [{ type: 'text', text }] })])
  const storage = session.d.log.storage as unknown as Integrity
  await first.close()
  await session.close()
  const db = new DatabaseSync(join(h.dataDir, 'sessions.db'))
  db.prepare(
    `UPDATE events SET data = json_set(data, '$.agnesVersion', 'tampered') WHERE session_key = ? AND seq = 1`,
  ).run(sessionId)
  db.close()
  return { sessionId, storage }
}

/** Holds the background verification (the second read from the first row) until released. */
function holdBackgroundVerify(storage: Integrity): () => void {
  const scan = storage.scanIntegrity
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  let folded = false
  storage.scanIntegrity = async (key, q) => {
    if (q.fromSeq === 1 && folded) await gate
    if (q.fromSeq === 1) folded = true
    return scan.call(storage, key, q)
  }
  return () => {
    storage.scanIntegrity = scan
    release()
  }
}

/** Every notification the endpoint pushes, in order. */
function collect(ep: Endpoint): Array<{ method?: string; params?: Record<string, unknown> }> {
  const seen: Array<{ method?: string; params?: Record<string, unknown> }> = []
  void (async () => {
    for await (const m of ep.notifications) seen.push(m as (typeof seen)[number])
  })()
  return seen
}

describe('a session whose history failed verification after it was shown', () => {
  it('is refused with the typed integrity code at every entry point, and the attached client is told', async () => {
    const h = await openTestHost()
    cleanup.push(() => h.close())
    await h.addWorkspace(h.dataDir)
    const { sessionId, storage } = await tamperedWithCheckpoint(h)
    const release = holdBackgroundVerify(storage)
    const ep = h.endpoint({ pollMs: 5 })
    cleanup.push(() => ep.close())
    const pushed = collect(ep)
    await ep.handle(initialize)
    expect(
      (await rpc(ep, 'session/load', { sessionId, cwd: h.dataDir, mcpServers: [] })).error,
    ).toBeUndefined()
    expect(h.host.kernel.get(sessionId)?.d.log.openStats.checkpoint).toMatchObject({ used: true })
    // While the verification runs the history is shown: attached, projected in full (the baseline a
    // patch continues from), and as a one-node window on another surface (for a history cursor).
    expect((await rpc(ep, '_agnes/v1/session.attach', { sessionId })).error).toBeUndefined()
    const full = await rpc<{ upto: number }>(ep, '_agnes/v1/session.projectUI', { sessionId })
    const upto = full.result?.upto
    expect(upto).toBeTypeOf('number')
    const opening = await rpc<{ history: { cursor?: string } }>(ep, '_agnes/v1/session.projectUIOpening', {
      sessionId,
      surface: 'tui',
      maxNodes: 1,
    })
    const cursor = opening.result?.history.cursor
    expect(cursor).toBeTypeOf('string')
    release()
    await expect(h.host.kernel.get(sessionId)?.d.log.fullVerified()).rejects.toMatchObject({
      code: 'E_LEDGER_INTEGRITY',
    })
    // The in-process host tells its attached client, as a worker-hosted daemon does.
    await vi.waitFor(() =>
      expect(pushed).toContainEqual(
        expect.objectContaining({
          method: '_agnes/v1/daemon.notice',
          params: expect.objectContaining({
            kind: 'integrity_failed',
            sessionId,
            detail: { code: 'E_LEDGER_INTEGRITY' },
          }),
        }),
      ),
    )

    const calls: Array<[string, Record<string, unknown>]> = [
      ['_agnes/v1/session.attach', { sessionId }],
      ['_agnes/v1/session.projectUI', { sessionId }],
      ['_agnes/v1/session.projectUIOpening', { sessionId }],
      ['_agnes/v1/session.projectUIHistory', { sessionId, cursor }],
      ['_agnes/v1/session.projectUIPatch', { sessionId, after: upto }],
      ['_agnes/v1/session.verifyHistory', { sessionId }],
      // Any ticket: looking for it reads the history of every session the caller owns.
      [
        '_agnes/v1/approval.decide',
        {
          ticket: '0123456789abcdef0123456789abcdef',
          verdict: 'allowed-once',
          approverCredential: { kind: 'local' },
        },
      ],
      ['session/prompt', { sessionId, prompt: [{ type: 'text', text: 'go on' }] }],
    ]
    for (const [method, params] of calls)
      expect({ method, error: (await rpc(ep, method, params)).error }).toMatchObject({
        method,
        error: refused,
      })
  })

  it('answers a prompt sent before the verification failed with the typed integrity code', async () => {
    const h = await openTestHost()
    cleanup.push(() => h.close())
    await h.addWorkspace(h.dataDir)
    const { sessionId, storage } = await tamperedWithCheckpoint(h)
    const release = holdBackgroundVerify(storage)
    const ep = h.endpoint({ pollMs: 5 })
    cleanup.push(() => ep.close())
    await ep.handle(initialize)
    expect(
      (await rpc(ep, 'session/load', { sessionId, cwd: h.dataDir, mcpServers: [] })).error,
    ).toBeUndefined()
    // The input is accepted while the verification runs; the turn waits for it, then fails with it.
    const prompt = rpc(ep, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'go on' }] })
    await new Promise((r) => setTimeout(r, 30))
    release()
    expect((await prompt).error).toMatchObject(refused)
  })

  it('refuses an approval whose implicit reopen fails verification with the typed integrity code', async () => {
    const h = await openTestHost()
    cleanup.push(() => h.close())
    await h.addWorkspace(h.dataDir)
    const { sessionId } = await tamperedWithCheckpoint(h)
    // No checkpoint: the reopen verifies from the first row and fails there.
    const db = new DatabaseSync(join(h.dataDir, 'sessions.db'))
    db.prepare('DELETE FROM ledger_verified_head_v1 WHERE session_key = ?').run(sessionId)
    db.close()
    const tickets = new MemoryTickets()
    const ticket = '0123456789abcdef0123456789abcdef'
    tickets.put(ticket, sessionId, Date.now() + 60_000)
    const ep = h.endpoint({ pollMs: 5, tickets })
    cleanup.push(() => ep.close())
    await ep.handle(initialize)
    const decided = await rpc(ep, '_agnes/v1/approval.decide', {
      ticket,
      verdict: 'allowed-once',
      approverCredential: { kind: 'local' },
    })
    expect(decided.error).toMatchObject(refused)
  })
})

describe('_agnes/v1/session.verifyHistory', () => {
  it('refuses a session that cannot say whether its history is verified', async () => {
    const h = await openTestHost()
    cleanup.push(() => h.close())
    await h.addWorkspace(h.dataDir)
    const ep = h.endpoint({ pollMs: 5 })
    cleanup.push(() => ep.close())
    await ep.handle(initialize)
    const created = await rpc<{ sessionId: string }>(ep, 'session/new', { cwd: h.dataDir, mcpServers: [] })
    const sessionId = created.result?.sessionId as string
    expect(await rpc(ep, '_agnes/v1/session.verifyHistory', { sessionId })).toMatchObject({ result: {} })
    const log = h.host.kernel.get(sessionId)?.d.log as unknown as Record<string, unknown>
    // Neither a verifyHistory of its own nor a log that reports full verification.
    log.fullVerified = undefined
    const reply = await rpc(ep, '_agnes/v1/session.verifyHistory', { sessionId })
    expect(reply.result).toBeUndefined()
    expect(reply.error?.data?.code).toBe('HISTORY_VERIFICATION_UNAVAILABLE')
    delete log.fullVerified
  })
})

describe('the endpoint records an integrity refusal it answers', () => {
  it('audits it with a diagnostic id and still answers the typed refusal', async () => {
    const audited: unknown[] = []
    const ep = new LocalEndpoint({
      clock: () => 0,
      principalId: 'p',
      audit: (record) => audited.push(record),
    })
    ep.register('initialize', async (_params, c) => {
      c.conn.initialized = true
      return { protocolVersion: 1, agentCapabilities: {}, authMethods: [] }
    })
    ep.register('_agnes/v1/session.verifyHistory', async () => {
      throw ledgerIntegrityRpcError()
    })
    await ep.handle(initialize)
    const reply = (await ep.handle({
      jsonrpc: '2.0',
      id: 2,
      method: '_agnes/v1/session.verifyHistory',
      params: { sessionId: 's' },
    })) as { error?: { data: Record<string, unknown> } }
    expect(reply.error?.data).toMatchObject({ code: 'E_LEDGER_INTEGRITY', reason: 'ledger-integrity' })
    expect(typeof reply.error?.data.diagnosticId).toBe('string')
    expect(audited).toEqual([
      {
        kind: 'daemon.request_failed',
        detail: {
          diagnosticId: reply.error?.data.diagnosticId,
          method: '_agnes/v1/session.verifyHistory',
          errorCode: 'E_LEDGER_INTEGRITY',
        },
      },
    ])
    await ep.close()
  })
})
