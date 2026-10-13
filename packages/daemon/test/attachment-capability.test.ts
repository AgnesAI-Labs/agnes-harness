import { afterEach, describe, expect, it } from 'vitest'
import type { JsonRpcMessage } from '../src/rpc.js'
import { openTestHost } from './host.js'

const sha = 'd'.repeat(64)
const imageRef = {
  type: 'image',
  mimeType: 'image/png',
  name: 'shot.png',
  attachment: { sha256: sha, bytes: 1234 },
  width: 640,
  height: 480,
}
const fileRef = {
  type: 'file',
  mimeType: 'application/zip',
  name: 'insects.zip',
  attachment: { sha256: sha, bytes: 99_000_000 },
}

const initialize = (refs: boolean) => ({
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      _meta: { 'ai.agnes.harness': { capabilities: refs ? { attachmentRefs: 1 } : {} } },
    },
  },
})

type Endpoint = ReturnType<Awaited<ReturnType<typeof openTestHost>>['endpoint']>
let nextId = 2
const rpc = async (ep: Endpoint, method: string, params: unknown) =>
  (await ep.handle({ jsonrpc: '2.0', id: nextId++, method, params })) as {
    result?: Record<string, unknown>
    error?: unknown
  }

async function drain(ep: Endpoint): Promise<JsonRpcMessage[]> {
  await ep.close()
  const out: JsonRpcMessage[] = []
  for await (const n of ep.notifications) out.push(n)
  return out
}

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

/** What one connection sees of a session holding a reference message, through each read path. */
async function seen(h: Awaited<ReturnType<typeof openTestHost>>, sessionId: string, refs: boolean) {
  const ep = h.endpoint({ pollMs: 5 })
  const init = (await ep.handle(initialize(refs))) as {
    result: { _meta: { agnes: Record<string, unknown> } }
  }
  expect(ep.conn.capabilities.attachmentRefs).toBe(refs)
  // Each connection opens the session itself; load comes first because it is what opens it here.
  const load = await rpc(ep, 'session/load', { sessionId, cwd: h.dataDir, mcpServers: [] })
  expect(load.error).toBeUndefined()
  const attach = await rpc(ep, '_agnes/v1/session.attach', {
    sessionId,
    filter: { preview: false, acpUpdates: false },
  })
  expect(attach.error).toBeUndefined()
  const opening = await rpc(ep, '_agnes/v1/session.projectUIOpening', { sessionId, surface: 'web' })
  expect(opening.error).toBeUndefined()
  const projected = await rpc(ep, '_agnes/v1/session.projectUI', { sessionId, surface: 'web' })
  expect(projected.error).toBeUndefined()
  // An opening of one node leaves the reference message to the history page.
  const windowed = await rpc(ep, '_agnes/v1/session.projectUIOpening', {
    sessionId,
    surface: 'tui',
    maxNodes: 1,
  })
  const cursor = (windowed.result?.history as { cursor?: string } | undefined)?.cursor
  if (!cursor) throw new Error(`no history cursor: ${JSON.stringify(windowed)}`)
  const history = await rpc(ep, '_agnes/v1/session.projectUIHistory', { sessionId, cursor, limit: 50 })
  expect(history.error).toBeUndefined()
  const diagnostics = await rpc(ep, '_agnes/v1/diagnostics.events', {
    sessionId,
    afterSeq: 0,
    limit: 500,
    maxBytes: 1024 * 1024,
  })
  expect(diagnostics.error).toBeUndefined()
  // A reference that arrives after the baseline reaches this connection as a patch.
  const live = h.host.kernel.get(sessionId)
  if (!live) throw new Error('session missing')
  await live.append([live.ev('user/message', { content: [fileRef] })])
  const patch = await rpc(ep, '_agnes/v1/session.projectUIPatch', {
    sessionId,
    surface: 'web',
    after: projected.result?.upto,
  })
  expect(patch.error).toBeUndefined()
  expect(JSON.stringify(patch.result)).toContain(`"insects.zip"`)
  const frames = (await drain(ep)) as Array<{ method?: string; params?: Record<string, unknown> }>
  const attached = frames
    .filter((f) => f.method === '_agnes/v1/session.event')
    .map((f) => f.params?.event as { type: string; data: { content?: unknown[] } })
    .filter((e) => e.type === 'user/message')
    .map((e) => e.data.content)
  const loaded = frames
    .filter((f) => f.method === 'session/update')
    .map((f) => (f.params?.update ?? {}) as { sessionUpdate?: string; content?: unknown })
    .filter((u) => u.sessionUpdate === 'user_message_chunk')
    .map((u) => u.content)
  return {
    init: init.result._meta.agnes,
    attached,
    loaded,
    opening: opening.result,
    projected: projected.result,
    history: history.result,
    diagnostics: diagnostics.result,
    patch: patch.result,
  }
}

describe('attachment reference capability', () => {
  it('hands reference blocks only to a connection that declared them, and links to them otherwise', async () => {
    const h = await openTestHost()
    cleanup.push(() => h.close())
    const setup = h.endpoint({ pollMs: 5 })
    cleanup.push(() => setup.close())
    await setup.handle(initialize(false))
    const created = await rpc(setup, 'session/new', { cwd: h.dataDir, mcpServers: [] })
    const sessionId = created.result?.sessionId as string
    const session = h.host.kernel.get(sessionId)
    if (!session) throw new Error('session missing')
    await session.append([session.ev('user/message', { content: [imageRef, fileRef] })])
    await session.append([session.ev('user/message', { content: [{ type: 'text', text: 'later' }] })])
    await setup.close()

    const a = await seen(h, sessionId, true)
    expect(a.init.attachmentRefs).toBe(1)
    expect(a.attached[0]).toEqual([imageRef, fileRef])
    // ACP itself has no reference block (its image needs inline data): a load gives everyone the link.
    expect(a.loaded[0]).toEqual({
      type: 'resource_link',
      uri: `artifact://${sha}`,
      mimeType: 'image/png',
      name: 'shot.png',
    })
    expect(JSON.stringify(a.opening)).toContain('"attachment"')
    expect(JSON.stringify(a.projected)).toContain('"attachment"')
    for (const result of [a.history, a.diagnostics, a.patch])
      expect(JSON.stringify(result)).toContain('"attachment"')

    const b = await seen(h, sessionId, false)
    // The server says it understands references whatever the client declared.
    expect(b.init.attachmentRefs).toBe(1)
    const link = { type: 'resource_link', uri: `artifact://${sha}`, mimeType: 'image/png', name: 'shot.png' }
    expect(b.attached[0]).toEqual([
      link,
      { type: 'text', text: '[image shot.png 640×480]' },
      { type: 'resource_link', uri: `artifact://${sha}`, name: 'insects.zip', mimeType: 'application/zip' },
    ])
    expect(b.loaded[0]).toEqual(link)
    expect(JSON.stringify(b.opening)).not.toContain('"attachment"')
    expect(JSON.stringify(b.opening)).toContain(`artifact://${sha}`)
    expect(JSON.stringify(b.projected)).not.toContain('"attachment"')
    for (const result of [b.history, b.diagnostics, b.patch]) {
      expect(JSON.stringify(result)).not.toContain('"attachment"')
      expect(JSON.stringify(result)).toContain(`artifact://${sha}`)
    }
  })
})
