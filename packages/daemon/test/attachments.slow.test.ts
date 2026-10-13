import { createHash } from 'node:crypto'
import { toAcpPrompt, UI_PROJECTION_MAX_BYTES, type UITimeline } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { openTestHost } from './host.js'

it('saves a 100 MiB attachment by reference, names it in a bounded Web history opening, and restores its exact bytes', async () => {
  const h = await openTestHost()
  const ep = h.endpoint()
  const draining = (async () => {
    for await (const _ of ep.notifications) {
      /* drain */
    }
  })()
  try {
    await ep.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          // A client that reads attachment references, as the Web client does.
          _meta: { 'ai.agnes.harness': { capabilities: { attachmentRefs: 1 } } },
        },
      },
    })
    const created = (await ep.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: h.dataDir, mcpServers: [] },
    })) as { result: { sessionId: string } }
    const sessionId = created.result.sessionId
    const original = Buffer.alloc(100 * 1024 * 1024)
    const sha256 = createHash('sha256').update(original).digest('hex')
    const content = [
      {
        type: 'file' as const,
        name: 'large.bin',
        mimeType: 'application/octet-stream',
        data: original.toString('base64'),
      },
    ]
    const saved = await ep.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: { sessionId, prompt: toAcpPrompt(content) },
    })
    expect(saved).toMatchObject({ result: { stopReason: 'end_turn' } })
    const opening = (await ep.handle({
      jsonrpc: '2.0',
      id: 4,
      method: '_agnes/v1/session.projectUIOpening',
      params: { sessionId, surface: 'web', maxBytes: UI_PROJECTION_MAX_BYTES },
    })) as { result: { timeline: UITimeline } }
    const user = opening.result.timeline.nodes.find((node) => node.kind === 'user')
    // The opening names the stored file; its bytes are not in the projection.
    expect(user).toMatchObject({
      kind: 'user',
      content: [
        {
          type: 'file',
          name: 'large.bin',
          mimeType: 'application/octet-stream',
          attachment: { sha256, bytes: original.byteLength },
        },
      ],
    })
    // The exact bytes come back through the attachment read, one window at a time.
    const hash = createHash('sha256')
    let offset = 0
    while (offset < original.byteLength) {
      const page = (await ep.handle({
        jsonrpc: '2.0',
        id: 10 + offset,
        method: '_agnes/v1/session.attachmentRead',
        params: { sessionId, seq: user?.seq, kind: 'file', index: 1, offset, length: 1024 * 1024 },
      })) as { result?: { base64: string; totalBytes: number } }
      if (!page.result) throw new Error(JSON.stringify(page))
      expect(page.result.totalBytes).toBe(original.byteLength)
      const bytes = Buffer.from(page.result.base64, 'base64')
      hash.update(bytes)
      offset += bytes.byteLength
    }
    expect(offset).toBe(original.byteLength)
    expect(hash.digest('hex')).toBe(sha256)
  } finally {
    await ep.close()
    await draining
    await h.close()
  }
}, 60000)
