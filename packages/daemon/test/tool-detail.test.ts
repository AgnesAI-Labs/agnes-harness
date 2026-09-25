import type { SessionReadToolDetailResult } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
type Response<T> = { result?: T; error?: { data?: { code?: string; reason?: string } } }
let nextId = 2
const rpc = async <T>(ep: Endpoint, method: string, params: unknown): Promise<Response<T>> =>
  (await ep.handle({ jsonrpc: '2.0', id: nextId++, method, params })) as Response<T>

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function setup() {
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
  const content = '完整输出'.repeat(20_000)
  const appended = await session.append([
    session.ev('turn/start', { turn: 1, trigger: 'prompt' }),
    session.ev('step/start', { turn: 1, step: 1 }),
    session.ev('tool/call', {
      toolUseId: 'a',
      name: 'read',
      args: { path: '/workspace/example' },
      ordinal: 0,
    }),
    session.ev('tool/call', { toolUseId: 'b', name: 'read', args: {}, ordinal: 1 }),
    session.ev('tool/result', {
      toolUseId: 'a',
      content: [{ type: 'text', text: content }],
      isError: false,
      enforcement: { level: 'full', scope: [] },
      authz: { decisionId: 'a' },
    }),
    session.ev('tool/result', {
      toolUseId: 'b',
      content: [{ type: 'text', text: 'other' }],
      isError: false,
      enforcement: { level: 'full', scope: [] },
      authz: { decisionId: 'b' },
    }),
    session.ev('step/end', { turn: 1, step: 1 }),
    session.ev('turn/end', { reason: 'completed', lastAssistantSeq: null }),
  ])
  const [, , callSeq, otherCallSeq, resultSeq, otherResultSeq] = appended.seqs
  if (!callSeq || !otherCallSeq || !resultSeq || !otherResultSeq) throw new Error('missing test seq')
  return { h, ep, session, sessionId, callSeq, otherCallSeq, resultSeq, otherResultSeq, content }
}

describe('session.readToolDetail', () => {
  it('pages exact full call and result bytes while leaving the active attach in place', async () => {
    const { ep, session, sessionId, callSeq, resultSeq, content } = await setup()
    const attached = await rpc<{ lastSeq: number }>(ep, '_agnes/v1/session.attach', {
      sessionId,
      cursor: { fromSeq: session.lastSeq, generation: 1 },
      filter: { preview: false, acpUpdates: false },
    })
    expect(attached.result?.lastSeq).toBe(session.lastSeq)
    const binding = ep.conn.attached.get(sessionId)
    const pending = ep.pending().events
    const chunks: Buffer[] = []
    let offset = 0
    for (;;) {
      const response = await rpc<SessionReadToolDetailResult>(ep, '_agnes/v1/session.readToolDetail', {
        sessionId,
        callSeq,
        resultSeq,
        offset,
        maxBytes: 16_384,
      })
      const page = response.result
      if (!page) throw new Error(JSON.stringify(response))
      expect(page.offset).toBe(offset)
      expect(page.callSeq).toBe(callSeq)
      expect(page.resultSeq).toBe(resultSeq)
      chunks.push(Buffer.from(page.data, 'base64'))
      if (page.nextOffset === null) {
        expect(Buffer.concat(chunks).byteLength).toBe(page.totalBytes)
        break
      }
      offset = page.nextOffset
    }
    const detail = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      call: { args: unknown }
      result: { content: Array<{ text: string }> }
    }
    expect(detail.call.args).toEqual({ path: '/workspace/example' })
    expect(detail.result.content[0]?.text).toBe(content)
    expect(ep.conn.attached.get(sessionId)).toBe(binding)
    expect(ep.pending().events).toBe(pending)
    const [liveSeq] = (
      await session.append([
        session.ev('user/message', { content: [{ type: 'text', text: 'after detail' }] }),
      ])
    ).seqs
    await vi.waitFor(() => expect(ep.pending().events).toBeGreaterThan(pending))
    await ep.close()
    const notifications: unknown[] = []
    for await (const notification of ep.notifications) notifications.push(notification)
    expect(notifications).toContainEqual(
      expect.objectContaining({
        method: '_agnes/v1/session.event',
        params: expect.objectContaining({ event: expect.objectContaining({ seq: liveSeq }) }),
      }),
    )
  })

  it('rejects wrong ownership, seq types, unrelated results and out-of-range offsets', async () => {
    const { h, ep, sessionId, callSeq, otherCallSeq, resultSeq, otherResultSeq } = await setup()
    const stranger = h.endpoint({
      identity: { principalId: 'other-principal', authKind: 'local', credentialKind: 'local' },
    })
    cleanup.push(() => stranger.close())
    await stranger.handle(initialize)
    expect(await rpc(stranger, '_agnes/v1/session.readToolDetail', { sessionId, callSeq })).toHaveProperty(
      'error.data.code',
      'CAPABILITY_DENIED',
    )
    const invalid = async (params: Record<string, unknown>) =>
      rpc(ep, '_agnes/v1/session.readToolDetail', { sessionId, ...params })
    expect(await invalid({ callSeq: resultSeq })).toHaveProperty('error.data.reason', 'call-not-found')
    expect(await invalid({ callSeq, resultSeq: otherCallSeq })).toHaveProperty(
      'error.data.reason',
      'result-not-found',
    )
    expect(await invalid({ callSeq, resultSeq: otherResultSeq })).toHaveProperty(
      'error.data.reason',
      'tool-use-id-mismatch',
    )
    expect(await invalid({ callSeq, offset: 1_000_000 })).toHaveProperty(
      'error.data.reason',
      'offset-out-of-range',
    )
    expect(await invalid({ callSeq, resultSeq: callSeq })).toHaveProperty('error.data.code', 'INVALID_PARAMS')
  })
})
