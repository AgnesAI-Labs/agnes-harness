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
})
