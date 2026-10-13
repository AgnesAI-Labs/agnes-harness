import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
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

type Endpoint = ReturnType<Awaited<ReturnType<typeof openTestHost>>['endpoint']>
type Response<T> = { result?: T; error?: { code?: number; data?: { code?: string; reason?: string } } }
type Page = { seq: number; base64: string; nextOffset: number | null }
let nextId = 2
const rpc = async <T>(ep: Endpoint, method: string, params: unknown): Promise<Response<T>> =>
  (await ep.handle({ jsonrpc: '2.0', id: nextId++, method, params })) as Response<T>

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

describe('_agnes/v1/session.exportRaw', () => {
  it('serves a stored row byte for byte, in pieces, to the session owner only', async () => {
    const h = await openTestHost()
    const ep = h.endpoint({ pollMs: 5 })
    cleanup.push(() => h.close())
    cleanup.push(() => ep.close())
    await ep.handle(initialize)
    const created = await rpc<{ sessionId: string }>(ep, 'session/new', { cwd: h.dataDir, mcpServers: [] })
    const sessionId = created.result?.sessionId
    if (!sessionId) throw new Error(JSON.stringify(created))
    const session = h.host.kernel.get(sessionId)
    if (!session) throw new Error('session missing')
    const data = Buffer.alloc(15 * 1024 * 1024, 5).toString('base64')
    expect(data.length).toBeGreaterThanOrEqual(20 * 1024 * 1024)
    const { seqs } = await session.append([
      session.ev('user/message', {
        content: [
          { type: 'text', text: 'archive' },
          { type: 'file', mimeType: 'application/zip', name: 'big.zip', data },
        ],
      }),
    ])
    const seq = seqs[0] as number
    const [row] = await session.scan({ fromSeq: seq, toSeq: seq, limit: 1 })
    const expected = Buffer.from(`${JSON.stringify(row)}\n`, 'utf8')

    const parts: Buffer[] = []
    let offset: number | null = 0
    while (offset !== null) {
      const response: Response<Page> = await rpc<Page>(ep, '_agnes/v1/session.exportRaw', {
        sessionId,
        seq,
        offset,
      })
      const page = response.result
      if (!page) throw new Error(JSON.stringify(response))
      expect(page.seq).toBe(seq)
      parts.push(Buffer.from(page.base64, 'base64'))
      offset = page.nextOffset
    }
    expect(parts.length).toBeGreaterThan(1)
    expect(Buffer.concat(parts).equals(expected)).toBe(true)

    const stranger = h.endpoint({
      identity: { principalId: 'other-principal', authKind: 'local', credentialKind: 'local' },
    })
    cleanup.push(() => stranger.close())
    await stranger.handle(initialize)
    const denied = await rpc(stranger, '_agnes/v1/session.exportRaw', { sessionId, seq, offset: 0 })
    // The session has a recorded owner, so the owner gate refuses rather than reporting it missing.
    expect(denied.error?.data?.code).toBe('CAPABILITY_DENIED')

    expect(
      await rpc(ep, '_agnes/v1/session.exportRaw', { sessionId, seq: seq + 100, offset: 0 }),
    ).toHaveProperty('error.data.reason', 'row-not-found')
  })

  type Integrity = { scanIntegrity(key: string, q: { fromSeq: number }): Promise<unknown> }

  /** A session with an attachment row, closed cleanly (so it has a checkpoint), and its storage. */
  async function closedWithCheckpoint(h: Awaited<ReturnType<typeof openTestHost>>) {
    const first = h.endpoint({ pollMs: 5 })
    await first.handle(initialize)
    await h.addWorkspace(h.dataDir)
    const created = await rpc<{ sessionId: string }>(first, 'session/new', { cwd: h.dataDir, mcpServers: [] })
    const sessionId = created.result?.sessionId
    if (!sessionId) throw new Error(JSON.stringify(created))
    const session = h.host.kernel.get(sessionId)
    if (!session) throw new Error('session missing')
    const { seqs } = await session.append([
      session.ev('user/message', {
        content: [{ type: 'file', mimeType: 'application/zip', name: 'a.zip', data: 'UEsDBA==' }],
      }),
    ])
    const storage = session.d.log.storage as unknown as Integrity
    await first.close()
    // Closing cleanly writes the verified-head checkpoint the next open starts from.
    await session.close()
    const db = new DatabaseSync(join(h.dataDir, 'sessions.db'), { readOnly: true })
    const head = db
      .prepare('SELECT through_seq AS through FROM ledger_verified_head_v1 WHERE session_key = ?')
      .get(sessionId) as { through: number } | undefined
    db.close()
    expect(head?.through).toBe(seqs[0])
    return { sessionId, seq: seqs[0] as number, storage }
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

  async function reopened(h: Awaited<ReturnType<typeof openTestHost>>, sessionId: string) {
    const ep = h.endpoint({ pollMs: 5 })
    cleanup.push(() => ep.close())
    await ep.handle(initialize)
    const loaded = await rpc(ep, 'session/load', { sessionId, cwd: h.dataDir, mcpServers: [] })
    expect(loaded.error).toBeUndefined()
    return ep
  }

  it('serves nothing until the history is verified, and nothing once it failed', async () => {
    const h = await openTestHost()
    cleanup.push(() => h.close())
    const { sessionId, seq, storage } = await closedWithCheckpoint(h)
    const db = new DatabaseSync(join(h.dataDir, 'sessions.db'))
    db.prepare(
      `UPDATE events SET data = json_set(data, '$.agnesVersion', 'tampered') WHERE session_key = ? AND seq = 1`,
    ).run(sessionId)
    db.close()
    const release = holdBackgroundVerify(storage)
    const ep = await reopened(h, sessionId)
    expect(h.host.kernel.get(sessionId)?.d.log.openStats.checkpoint).toMatchObject({ used: true })
    let settled = false
    const pending = rpc<Page>(ep, '_agnes/v1/session.exportRaw', { sessionId, seq, offset: 0 }).finally(
      () => {
        settled = true
      },
    )
    await new Promise((r) => setTimeout(r, 30))
    expect(settled).toBe(false)
    release()
    const refused = await pending
    expect(refused.result).toBeUndefined()
    expect(refused.error?.data).toEqual({ code: 'E_LEDGER_INTEGRITY' })
    // A later piece, of any row, is refused the same way.
    const again = await rpc<Page>(ep, '_agnes/v1/session.exportRaw', { sessionId, seq: 1, offset: 0 })
    expect(again.result).toBeUndefined()
    expect(again.error?.data).toEqual({ code: 'E_LEDGER_INTEGRITY' })
  })

  it('serves a row of a history opened from a checkpoint once its verification has passed', async () => {
    const h = await openTestHost()
    cleanup.push(() => h.close())
    const { sessionId, seq, storage } = await closedWithCheckpoint(h)
    const release = holdBackgroundVerify(storage)
    const ep = await reopened(h, sessionId)
    expect(h.host.kernel.get(sessionId)?.d.log.openStats.checkpoint).toMatchObject({ used: true })
    let settled = false
    const pending = rpc<Page>(ep, '_agnes/v1/session.exportRaw', { sessionId, seq, offset: 0 }).finally(
      () => {
        settled = true
      },
    )
    await new Promise((r) => setTimeout(r, 30))
    expect(settled).toBe(false)
    release()
    const page = (await pending).result
    expect(page?.nextOffset).toBeNull()
    expect(Buffer.from(page?.base64 ?? '', 'base64').toString('utf8')).toContain('"name":"a.zip"')
  })
})
